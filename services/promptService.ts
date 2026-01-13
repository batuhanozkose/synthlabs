
import { SettingsService } from './settingsService';

// Use import.meta.glob to load all prompt text files
const promptFiles = import.meta.glob('/prompts/**/*.txt', { query: '?raw', import: 'default', eager: true });

// Load metadata files
const metaFiles = import.meta.glob('/prompts/**/meta.json', { eager: true });

type PromptCategory = 'generator' | 'converter' | 'verifier';

export interface PromptSetMetadata {
    name: string;
    description: string;
    author?: string;
    version?: string;
    symbols?: string[];
    format?: string;
    features?: string[];
    extends?: string;  // Parent prompt set to inherit from
}

export const PromptService = {
    /**
     * Helper to get metadata for inheritance chain lookup
     */
    _getMetadataInternal(setId: string): PromptSetMetadata | null {
        const metaPath = `/prompts/${setId}/meta.json`;
        const meta = metaFiles[metaPath];
        if (meta && typeof meta === 'object' && 'default' in meta) {
            return meta.default as PromptSetMetadata;
        }
        if (meta) {
            return meta as PromptSetMetadata;
        }
        return null;
    },

    /**
     * Checks if a prompt set has a meta.json file (not just a fallback).
     * Used to distinguish official prompt sets from user-created ones.
     */
    hasMetaFile(setId: string): boolean {
        const metaPath = `/prompts/${setId}/meta.json`;
        return metaPath in metaFiles;
    },

    /**
     * Retrieves a prompt template by role and category.
     * Supports inheritance: if a prompt isn't found in a set, checks parent set (via 'extends'),
     * then falls back to 'default'.
     * NOTE: 'default' is the terminal set and cannot extend anything - any 'extends' in its meta.json is ignored.
     */
    getPrompt(category: PromptCategory, role: string, forceSetId?: string): string {
        const setId = forceSetId || SettingsService.getSettings().promptSet || 'default';
        const defaultPath = `/prompts/default/${category}/${role}.txt`;

        // Build inheritance chain (prevent infinite loops with visited set)
        const visited = new Set<string>();
        let currentSetId: string | undefined = setId;

        while (currentSetId) {
            // Check for circular inheritance
            if (visited.has(currentSetId)) {
                console.warn(`[PromptService] Circular inheritance detected: ${Array.from(visited).join(' -> ')} -> ${currentSetId}`);
                break;
            }
            visited.add(currentSetId);

            // Try current set
            const currentPath = `/prompts/${currentSetId}/${category}/${role}.txt`;
            if (promptFiles[currentPath]) {
                return promptFiles[currentPath] as string;
            }

            // Check for parent via 'extends' in metadata
            if (currentSetId !== 'default') {
                const meta = this._getMetadataInternal(currentSetId);
                if (meta?.extends) {
                    // Warn if the parent set doesn't exist
                    if (!this.hasMetaFile(meta.extends) && meta.extends !== 'default') {
                        console.warn(`[PromptService] Set '${currentSetId}' extends '${meta.extends}' which has no meta.json`);
                    }
                    currentSetId = meta.extends;
                } else {
                    currentSetId = undefined; // No parent, will fall through to default
                }
            } else {
                break; // Reached default, stop
            }
        }

        // Fall back to default
        if (promptFiles[defaultPath]) {
            return promptFiles[defaultPath] as string;
        }

        console.error(`Prompt completely missing: ${category}/${role} (Set: ${setId})`);
        return '';
    },

    /**
     * Discovers all available prompt sets by scanning the directories.
     */
    getAvailableSets(): string[] {
        const sets = new Set<string>();

        Object.keys(promptFiles).forEach(path => {
            // Path format: /prompts/<setId>/<category>/<role>.txt
            const parts = path.split('/');
            // ["", "prompts", "setId", "category", "file"]
            if (parts.length >= 3 && parts[1] === 'prompts') {
                sets.add(parts[2]);
            }
        });

        return Array.from(sets).sort();
    },

    /**
     * Gets metadata for a specific prompt set.
     */
    getSetMetadata(setId: string): PromptSetMetadata | null {
        return this._getMetadataInternal(setId);
    },

    /**
     * Gets metadata for all available prompt sets.
     */
    getAllMetadata(): Record<string, PromptSetMetadata> {
        const result: Record<string, PromptSetMetadata> = {};
        const sets = this.getAvailableSets();

        for (const setId of sets) {
            const meta = this.getSetMetadata(setId);
            if (meta) {
                result[setId] = meta;
            } else {
                // Provide fallback metadata for sets without meta.json
                result[setId] = {
                    name: setId.charAt(0).toUpperCase() + setId.slice(1),
                    description: `Prompt set: ${setId}`
                };
            }
        }

        return result;
    },

    /**
     * Checks which prompts exist in a set vs the default set.
     */
    getSetCompleteness(setId: string): {
        total: number;
        present: number;
        missing: string[];
    } {
        const defaultPrompts = Object.keys(promptFiles)
            .filter(p => p.startsWith('/prompts/default/'))
            .map(p => p.replace('/prompts/default/', ''));

        const setPrompts = Object.keys(promptFiles)
            .filter(p => p.startsWith(`/prompts/${setId}/`))
            .map(p => p.replace(`/prompts/${setId}/`, ''));

        const missing = defaultPrompts.filter(p => !setPrompts.includes(p));

        return {
            total: defaultPrompts.length,
            present: setPrompts.length,
            missing
        };
    }
};
