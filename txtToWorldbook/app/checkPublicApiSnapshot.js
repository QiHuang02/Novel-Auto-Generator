import { createPublicApi } from './publicApi.js';
import { PUBLIC_API_KEYS_SNAPSHOT } from './publicApi.snapshot.js';

function noop() {}

function buildNoopDeps() {
    return {
        open: noop,
        closeModal: noop,
        rollbackToHistory: noop,
        AppState: {
            worldbook: { generated: {}, volumes: [] },
            memory: { queue: [] },
            config: { parallel: {}, categoryLight: {}, chapterRegex: {} },
            persistent: { customCategories: [], defaultEntries: [] },
            settings: {},
        },
        getAllVolumesWorldbook: noop,
        saveTaskState: noop,
        loadTaskState: noop,
        exportSettings: noop,
        importSettings: noop,
        handleRerollMemory: noop,
        handleRerollSingleEntry: noop,
        findEntrySourceMemories: noop,
        showRerollEntryModal: noop,
        showBatchRerollModal: noop,
        showRollHistorySelector: noop,
        importAndMergeWorldbook: noop,
        setCategoryLightState: noop,
        rebuildWorldbookFromMemories: noop,
        applyDefaultWorldbookEntries: noop,
        callCustomAPI: noop,
        callSillyTavernAPI: noop,
        showConsolidateCategorySelector: noop,
        showAliasMergeUI: noop,
        showManualMergeUI: noop,
        getEnabledCategories: noop,
        rechunkMemories: noop,
        showSearchModal: noop,
        showReplaceModal: noop,
        getEntryConfig: noop,
        setEntryConfig: noop,
        setCategoryDefaultConfig: noop,
        MemoryHistoryDB: {
            getEntryRollResults: noop,
            clearEntryRollResults: noop,
        },
    };
}

export function checkPublicApiSnapshot() {
    const api = createPublicApi(buildNoopDeps());
    const actual = Object.keys(api).sort();
    const expected = [...PUBLIC_API_KEYS_SNAPSHOT].sort();

    const missing = expected.filter((k) => !actual.includes(k));
    const added = actual.filter((k) => !expected.includes(k));

    return {
        pass: missing.length === 0 && added.length === 0,
        missing,
        added,
        expectedCount: expected.length,
        actualCount: actual.length,
    };
}

const isDirectRun = (() => {
    const target = (process.argv[1] || '').replace(/\\/g, '/');
    return target.endsWith('/checkPublicApiSnapshot.js');
})();

if (isDirectRun) {
    const result = checkPublicApiSnapshot();
    if (!result.pass) {
        console.error('[publicApi snapshot] FAILED');
        console.error('missing:', result.missing);
        console.error('added:', result.added);
        process.exit(1);
    }
    console.log(`[publicApi snapshot] OK (${result.actualCount} keys)`);
}
