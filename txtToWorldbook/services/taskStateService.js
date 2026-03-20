export function createTaskStateService(deps = {}) {
    const {
        AppState,
        defaultSettings,
        ErrorHandler,
        getExportBaseName,
        rebuildWorldbookFromMemories,
        showQueueSection,
        updateMemoryQueueUI,
        updateVolumeIndicator,
        updateStartButtonState,
        updateSettingsUI,
        renderCategoriesList,
        renderDefaultWorldbookEntriesUI,
        updateChapterRegexUI,
        showResultSection,
        updateWorldbookPreview,
    } = deps;

    async function saveTaskState() {
        const state = {
            version: '2.9.0',
            timestamp: Date.now(),
            memoryQueue: AppState.memory.queue,
            generatedWorldbook: AppState.worldbook.generated,
            worldbookVolumes: AppState.worldbook.volumes,
            currentVolumeIndex: AppState.worldbook.currentVolumeIndex,
            fileHash: AppState.file.hash,
            settings: AppState.settings,
            parallelConfig: AppState.config.parallel,
            categoryLightSettings: AppState.config.categoryLight,
            customWorldbookCategories: AppState.persistent.customCategories,
            chapterRegexSettings: AppState.config.chapterRegex,
            defaultWorldbookEntriesUI: AppState.persistent.defaultEntries,
            categoryDefaultConfig: AppState.config.categoryDefault,
            entryPositionConfig: AppState.config.entryPosition,
            originalFileName: AppState.file.current ? AppState.file.current.name : null,
            novelName: AppState.file.novelName || '',
        };

        const timeString = new Date()
            .toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            })
            .replace(/[:/\s]/g, '')
            .replace(/,/g, '-');

        const baseName = getExportBaseName('任务状态');
        const fileName = `${baseName}-任务状态-${timeString}.json`;
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        const processedCount = AppState.memory.queue.filter((m) => m.processed).length;
        ErrorHandler.showUserSuccess(`任务状态已导出！已处理: ${processedCount}/${AppState.memory.queue.length}`);
    }

    async function loadTaskState() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const content = await file.text();
                const state = JSON.parse(content);
                if (!state.memoryQueue || !Array.isArray(state.memoryQueue)) {
                    throw new Error('无效的任务状态文件');
                }

                AppState.memory.queue = state.memoryQueue;
                AppState.worldbook.generated = state.generatedWorldbook || {};
                AppState.worldbook.volumes = state.worldbookVolumes || [];
                AppState.worldbook.currentVolumeIndex = state.currentVolumeIndex || 0;
                AppState.file.hash = state.fileHash || null;

                if (state.settings) AppState.settings = { ...defaultSettings, ...state.settings };
                if (state.parallelConfig) AppState.config.parallel = { ...AppState.config.parallel, ...state.parallelConfig };
                if (state.categoryLightSettings) AppState.config.categoryLight = { ...AppState.config.categoryLight, ...state.categoryLightSettings };
                if (state.customWorldbookCategories) AppState.persistent.customCategories = state.customWorldbookCategories;
                if (state.chapterRegexSettings) AppState.config.chapterRegex = state.chapterRegexSettings;
                if (state.defaultWorldbookEntriesUI) AppState.persistent.defaultEntries = state.defaultWorldbookEntriesUI;
                if (state.categoryDefaultConfig) AppState.config.categoryDefault = state.categoryDefaultConfig;
                if (state.entryPositionConfig) AppState.config.entryPosition = state.entryPositionConfig;

                if (state.novelName) {
                    AppState.file.novelName = state.novelName;
                } else if (state.originalFileName) {
                    AppState.file.novelName = state.originalFileName.replace(/\.[^/.]+$/, '');
                }

                const fileNameEl = document.getElementById('ttw-file-name');
                if (fileNameEl && state.originalFileName) {
                    fileNameEl.textContent = state.originalFileName;
                }

                const novelNameInput = document.getElementById('ttw-novel-name-input');
                if (novelNameInput && AppState.file.novelName) {
                    novelNameInput.value = AppState.file.novelName;
                }

                const novelNameRow = document.getElementById('ttw-novel-name-row');
                if (novelNameRow) novelNameRow.style.display = 'flex';

                if (Object.keys(AppState.worldbook.generated).length === 0) {
                    rebuildWorldbookFromMemories();
                }

                const firstUnprocessed = AppState.memory.queue.findIndex((m) => !m.processed || m.failed);
                AppState.memory.startIndex = firstUnprocessed !== -1 ? firstUnprocessed : 0;
                AppState.memory.userSelectedIndex = null;

                showQueueSection(true);
                updateMemoryQueueUI();
                if (AppState.processing.volumeMode) updateVolumeIndicator();
                updateStartButtonState(false);
                updateSettingsUI();
                renderCategoriesList();
                renderDefaultWorldbookEntriesUI();
                updateChapterRegexUI();

                if (Object.keys(AppState.worldbook.generated).length > 0) {
                    showResultSection(true);
                    updateWorldbookPreview();
                }

                const processedCount = AppState.memory.queue.filter((m) => m.processed).length;
                ErrorHandler.showUserSuccess(`导入成功！已处理: ${processedCount}/${AppState.memory.queue.length}`);
                document.getElementById('ttw-start-btn').disabled = false;
            } catch (error) {
                ErrorHandler.showUserError(`导入失败: ${error.message}`);
            }
        };

        input.click();
    }

    return {
        saveTaskState,
        loadTaskState,
    };
}
