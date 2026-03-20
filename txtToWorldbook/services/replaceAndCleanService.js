/**
 * Replace/Clean domain service skeleton.
 * Centralizes text cleanup utilities so UI code can stay thin.
 */
export function createReplaceAndCleanService(deps = {}) {
    const {
        AppState,
    } = deps;

    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function makeReplaceRegex(findText, options = {}) {
        const {
            caseSensitive = false,
        } = options;
        const flags = caseSensitive ? 'g' : 'gi';
        return new RegExp(escapeRegExp(findText), flags);
    }

    function replaceInEntry(entry, regex, replaceWith) {
        let changed = 0;
        if (!entry || typeof entry !== 'object') return changed;

        if (Array.isArray(entry['关键词'])) {
            entry['关键词'] = entry['关键词']
                .map((kw) => {
                    const next = String(kw).replace(regex, replaceWith);
                    if (next !== kw) changed += 1;
                    return next;
                })
                .filter(Boolean);
        }

        if (typeof entry['内容'] === 'string') {
            const before = entry['内容'];
            const after = before.replace(regex, replaceWith);
            if (after !== before) {
                changed += 1;
                entry['内容'] = after;
            }
        }

        return changed;
    }

    function replaceInWorldbook(findText, replaceWith, options = {}) {
        if (!findText) return { changed: 0 };
        const regex = makeReplaceRegex(findText, options);
        let changed = 0;

        for (const category of Object.keys(AppState.worldbook.generated || {})) {
            const entries = AppState.worldbook.generated[category] || {};
            for (const entryName of Object.keys(entries)) {
                changed += replaceInEntry(entries[entryName], regex, replaceWith);
            }
        }

        return { changed };
    }

    return {
        replaceInWorldbook,
        makeReplaceRegex,
    };
}

