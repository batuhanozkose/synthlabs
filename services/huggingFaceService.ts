
import { HuggingFaceConfig } from "../types";
// @ts-ignore
import * as hyparquet from 'hyparquet';
import { createRepo, uploadFile } from "@huggingface/hub";
import { logger } from '../utils/logger';

const MAX_BATCH_SIZE = 100;
const MAX_CONCURRENT_FETCHES = 3;

// Handle import compatibility (ESM/CJS fallback)
// @ts-ignore
const parquetWrite = hyparquet.parquetWrite || hyparquet.default?.parquetWrite;

export const searchDatasets = async (query: string): Promise<string[]> => {
    if (!query || query.length < 2) return [];
    try {
        const res = await fetch(`https://huggingface.co/api/datasets?search=${encodeURIComponent(query)}&limit=5&sort=downloads&direction=-1`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.map((d: any) => d.id);
    } catch (e) {
        console.error("HF Search Error", e);
        return [];
    }
};

export const getDatasetStructure = async (dataset: string): Promise<{ configs: string[], splits: Record<string, string[]> }> => {
    try {
        const res = await fetch(`https://datasets-server.huggingface.co/splits?dataset=${dataset}`);
        if (!res.ok) return { configs: [], splits: {} };
        const data = await res.json();

        const configMap: Record<string, string[]> = {};
        if (data.splits) {
            data.splits.forEach((item: any) => {
                if (!configMap[item.config]) configMap[item.config] = [];
                configMap[item.config].push(item.split);
            });
        }
        return {
            configs: Object.keys(configMap),
            splits: configMap
        };
    } catch (e) {
        console.error("HF Structure failed", e);
        return { configs: [], splits: {} };
    }
};

export const fetchHuggingFaceRows = async (
    hfConfig: HuggingFaceConfig,
    offset: number,
    length: number
): Promise<any[]> => {
    const batchConfigs = [];
    let currentOffset = offset;
    let remaining = length;

    while (remaining > 0) {
        const batchSize = Math.min(remaining, MAX_BATCH_SIZE);
        batchConfigs.push({ offset: currentOffset, length: batchSize });
        currentOffset += batchSize;
        remaining -= batchSize;
    }

    const results: any[][] = new Array(batchConfigs.length);
    const executing: Promise<void>[] = [];

    for (let i = 0; i < batchConfigs.length; i++) {
        const config = batchConfigs[i];
        const fetchOp = fetchSingleBatch(hfConfig, config.offset, config.length)
            .then(rows => { results[i] = rows; });

        const wrapper = fetchOp.then(() => {
            const index = executing.indexOf(wrapper);
            if (index > -1) executing.splice(index, 1);
        });

        executing.push(wrapper);
        if (executing.length >= MAX_CONCURRENT_FETCHES) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results.flat();
};

const fetchSingleBatch = async (
    hfConfig: HuggingFaceConfig,
    offset: number,
    length: number
): Promise<any[]> => {
    try {
        const url = `https://datasets-server.huggingface.co/rows?dataset=${hfConfig.dataset}&config=${hfConfig.config}&split=${hfConfig.split}&offset=${offset}&length=${length}`;
        const response = await fetch(url);
        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                const errData = await response.json();
                if (errData.error) errorMsg = errData.error;
            } catch (e) { }
            throw new Error(`HF API Error ${response.status}: ${errorMsg}`);
        }
        const data = await response.json();
        if (!data.rows) return [];
        return data.rows.map((r: any) => r.row);
    } catch (err: any) {
        throw err;
    }
};

// --- Hyparquet Helpers ---

function inferSchema(data: any[]): any[] {
    if (!data || data.length === 0) return [];

    // Sample first non-null values for each key
    const keys = new Set<string>();
    data.forEach(d => Object.keys(d).forEach(k => keys.add(k)));

    const schema: any[] = [];

    keys.forEach(key => {
        let type = 'BYTE_ARRAY';
        let originalType = 'UTF8'; // Default to String

        for (const row of data) {
            const val = row[key];
            if (val !== null && val !== undefined) {
                if (typeof val === 'boolean') {
                    type = 'BOOLEAN';
                    originalType = undefined as any;
                }
                else if (typeof val === 'number') {
                    type = 'DOUBLE';
                    originalType = undefined as any;
                }
                break;
            }
        }

        const colDef: any = {
            name: key,
            type: type,
            optional: true
        };

        if (originalType) {
            colDef.originalType = originalType;
        }

        schema.push(colDef);
    });

    return schema;
}

function dataToRowGroups(data: any[], schema: any[]): any[][] {
    // Hyparquet expects array of rows, where each row is an array of values in schema order
    return data.map(row => {
        return schema.map(col => {
            const val = row[col.name];
            if (val === null || val === undefined) return null;
            if (col.type === 'BYTE_ARRAY' && typeof val !== 'string') return JSON.stringify(val);
            return val;
        });
    });
}

/**
 * Generates Parquet bytes using hyparquet (pure JS).
 */
export const generateParquetBuffer = async (data: any[]): Promise<Uint8Array> => {
    try {
        logger.log(`Generating Parquet from ${data.length} rows...`);
        if (!data || data.length === 0) throw new Error("No data to convert");

        // 1. Infer Schema
        const schema = inferSchema(data);

        // 2. Convert to Row Format (Array of Arrays)
        const rows = dataToRowGroups(data, schema);

        // 3. Write
        return new Promise((resolve, reject) => {
            try {
                if (!parquetWrite) {
                    // Try to debug what IS available
                    console.error("Available hyparquet exports:", Object.keys(hyparquet));
                    throw new Error("parquetWrite function not found in hyparquet import");
                }

                parquetWrite({
                    schema,
                    rowGroups: [rows], // Array of RowGroups (which are Array of Rows)
                    onComplete: (buffer: ArrayBuffer) => {
                        resolve(new Uint8Array(buffer));
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    } catch (e: any) {
        console.error("Parquet Generation Error:", e);
        throw new Error("Failed during Parquet conversion: " + e.message);
    }
};

/**
 * Pushes data to Hugging Face Hub using the @huggingface/hub library.
 */
export const uploadToHuggingFace = async (
    token: string,
    repoId: string,
    data: any[],
    filename: string = 'data.jsonl',
    privateRepo: boolean = true,
    format: 'jsonl' | 'parquet' = 'jsonl'
): Promise<string> => {

    if (!data || data.length === 0) {
        throw new Error("No data to upload.");
    }

    const credentials = { accessToken: token };
    const repo = { type: "dataset" as const, name: repoId };

    // 1. Create Repo (Idempotent-ish)
    try {
        logger.log(`Creating repo ${repoId} if needed...`);
        await createRepo({
            repo,
            credentials,
            private: privateRepo
        });
    } catch (e: any) {
        // 409 Conflict means repo exists, which is fine
        if (!e.message?.includes("409") && !e.message?.includes("exists")) {
            logger.warn("Repo creation warning:", e);
        }
    }

    // 2. Prepare Data Content
    let blob: Blob;
    let finalFilename = filename;

    logger.log(`Preparing content in format: ${format}`);

    if (format === 'parquet') {
        try {
            const parquetBytes = await generateParquetBuffer(data);
            blob = new Blob([parquetBytes], { type: 'application/octet-stream' });
            if (!finalFilename.endsWith('.parquet')) finalFilename = finalFilename.replace(/\.jsonl$/, '') + '.parquet';
        } catch (e: any) {
            throw new Error("Parquet conversion failed: " + e.message);
        }
    } else {
        // JSONL
        const jsonlData = data.map(item => JSON.stringify(item)).join('\n');
        blob = new Blob([jsonlData], { type: 'application/json' });
    }

    // 3. Upload File
    logger.log(`Uploading ${finalFilename} to ${repoId}...`);

    await uploadFile({
        repo,
        credentials,
        file: {
            path: finalFilename,
            content: blob
        },
        // Use commitTitle to avoid @huggingface/hub validation error on commitMessage
        commitTitle: `Upload ${finalFilename} via SynthLabs (${format})`
    });

    return `https://huggingface.co/datasets/${repoId}`;
};
