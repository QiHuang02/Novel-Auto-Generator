/**
 * SillyTavern API adapter.
 * Keeps transport details outside feature services.
 */
export function createTavernApiAdapter(deps = {}) {
    const {
        callSillyTavernAPI,
        ErrorHandler = null,
    } = deps;

    async function generate(prompt, options = {}) {
        if (typeof callSillyTavernAPI !== 'function') {
            throw new Error('callSillyTavernAPI is not configured');
        }

        try {
            return await callSillyTavernAPI(prompt, options);
        } catch (error) {
            if (ErrorHandler?.handle) {
                ErrorHandler.handle(error, 'TavernApiAdapter');
            }
            throw error;
        }
    }

    return {
        generate,
    };
}

