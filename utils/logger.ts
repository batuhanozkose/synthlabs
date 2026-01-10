/**
 * Development-only logger utility.
 * Wraps console methods to only output when VITE_DEBUG_MODE is enabled or in development.
 */

const isDev = import.meta.env.DEV || import.meta.env.VITE_DEBUG_MODE === 'true';

export const logger = {
    log: (...args: any[]) => {
        if (isDev) console.log(...args);
    },
    warn: (...args: any[]) => {
        if (isDev) console.warn(...args);
    },
    error: (...args: any[]) => {
        // Errors are always logged
        console.error(...args);
    },
    group: (label: string) => {
        if (isDev) console.group(label);
    },
    groupCollapsed: (label: string) => {
        if (isDev) console.groupCollapsed(label);
    },
    groupEnd: () => {
        if (isDev) console.groupEnd();
    }
};
