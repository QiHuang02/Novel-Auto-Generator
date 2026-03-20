import { runWithConcurrency } from '../core/concurrency.js';

export function createRerollService(deps = {}) {
    const {
        AppState,
        MemoryHistoryDB,
        updateStopButtonVisibility = () => {},
        updateStreamContent = () => {},
        updateMemoryQueueUI = () => {},
        processMemoryChunkIndependent,
        mergeWorldbookDataWithHistory = async () => [],
        updateWorldbookPreview = () => {},
        setProcessingStatus = () => {},
        getProcessingStatus = () => 'idle',
        callAPI,
        parseAIResponse,
        getChapterForcePrompt = () => '',
        getLanguagePrefix = () => '',
        getPreviousMemoryContext = () => '',
    } = deps;

    function beginRerollScope() {
        const ownsStatus = getProcessingStatus() !== 'rerolling';
        if (ownsStatus) {
            setProcessingStatus('rerolling');
            updateStopButtonVisibility(true);
        }
        return ownsStatus;
    }

    function endRerollScope(ownsStatus) {
        if (!ownsStatus) {
            return;
        }

        if (getProcessingStatus() !== 'stopped') {
            setProcessingStatus('idle');
            updateStopButtonVisibility(false);
        }
    }

    async function handleRerollMemory(index, customPrompt = '') {
        const memory = AppState?.memory?.queue?.[index];
        if (!memory) {
            return null;
        }

        const ownsStatus = beginRerollScope();
        updateStreamContent(`\n🎲 开始重Roll: ${memory.title} (第${index + 1}章)\n`);

        try {
            memory.processing = true;
            updateMemoryQueueUI();

            const result = await processMemoryChunkIndependent({
                index,
                retryCount: 0,
                customPromptSuffix: customPrompt,
            });

            memory.processing = false;

            if (result) {
                await MemoryHistoryDB.saveRollResult(index, result);
                memory.result = result;
                memory.processed = true;
                memory.failed = false;

                await mergeWorldbookDataWithHistory({
                    target: AppState.worldbook.generated,
                    source: result,
                    memoryIndex: index,
                    memoryTitle: `${memory.title}-重Roll`,
                });

                updateStreamContent(`✅ 重Roll完成: ${memory.title}\n`);
                updateMemoryQueueUI();
                updateWorldbookPreview();
                return result;
            }

            return null;
        } catch (error) {
            memory.processing = false;
            if (error.message !== 'ABORTED') {
                updateStreamContent(`❌ 重Roll失败: ${error.message}\n`);
            }
            updateMemoryQueueUI();
            throw error;
        } finally {
            endRerollScope(ownsStatus);
        }
    }

    function findEntrySourceMemories(category, entryName) {
        const sources = [];
        for (let i = 0; i < AppState.memory.queue.length; i += 1) {
            const memory = AppState.memory.queue[i];
            if (!memory.result || memory.failed) continue;
            if (memory.result[category] && memory.result[category][entryName]) {
                sources.push({
                    memoryIndex: i,
                    memory,
                    entry: memory.result[category][entryName],
                });
            }
        }
        return sources;
    }

    async function handleRerollSingleEntry(options = {}) {
        const {
            memoryIndex,
            category,
            entryName,
            customPrompt = '',
            manageStatus = true,
        } = options;

        const memory = AppState?.memory?.queue?.[memoryIndex];
        if (!memory) {
            throw new Error('找不到对应的章节');
        }

        const ownsStatus = manageStatus ? beginRerollScope() : false;
        updateStreamContent(
            `\n🎯 开始单独重Roll条目: [${category}] ${entryName} (来自第${memoryIndex + 1}章)\n`,
        );

        const chapterIndex = memoryIndex + 1;
        const chapterForcePrompt = AppState.settings.forceChapterMarker
            ? getChapterForcePrompt(chapterIndex)
            : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix();

        const categoryConfig = AppState.persistent.customCategories.find(
            (item) => item.name === category,
        );
        const contentGuide = categoryConfig ? categoryConfig.contentGuide : '';

        prompt += `\n你是一个专业的小说世界书条目生成助手。请根据以下原文内容，专门重新生成指定的条目。\n`;
        prompt += `\n【任务说明】\n`;
        prompt += `- 只需要生成一个条目：分类="${category}"，条目名称="${entryName}"\n`;
        prompt += `- 请基于原文内容重新分析并生成该条目的信息\n`;
        prompt += `- 输出格式必须是JSON，结构为：{ "${category}": { "${entryName}": { "关键词": [...], "内容": "..." } } }\n`;

        if (contentGuide) {
            prompt += `\n【该分类的内容指南】\n${contentGuide}\n`;
        }

        const prevContext = getPreviousMemoryContext(memoryIndex);
        if (prevContext) {
            prompt += prevContext;
        }

        if (memoryIndex > 0 && AppState.memory.queue[memoryIndex - 1]?.content) {
            prompt += `\n\n前文结尾（供参考）：\n---\n${AppState.memory.queue[memoryIndex - 1].content.slice(-500)}\n---\n`;
        }

        prompt += `\n\n需要分析的原文内容（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        const currentEntry = memory.result?.[category]?.[entryName];
        if (currentEntry) {
            prompt += `\n\n【当前条目信息（供参考，请重新分析生成）】\n`;
            prompt += JSON.stringify(currentEntry, null, 2);
        }

        prompt += `\n\n请重新分析原文，生成更准确、更详细的条目信息。`;

        if (customPrompt) {
            prompt += `\n\n【用户额外要求】\n${customPrompt}`;
        }

        if (
            AppState.settings.forceChapterMarker
            && (category === '剧情大纲' || category === '剧情节点' || category === '章节剧情')
        ) {
            prompt += `\n\n【重要提醒】条目名称必须包含"第${chapterIndex}章"！`;
        }

        if (AppState.settings.customSuffixPrompt?.trim()) {
            prompt += `\n\n${AppState.settings.customSuffixPrompt.trim()}`;
        }

        prompt += `\n\n直接输出JSON格式结果，不要有其他内容。`;

        try {
            memory.processing = true;
            updateMemoryQueueUI();

            const response = await callAPI(prompt, memoryIndex + 1);

            memory.processing = false;

            if (AppState.processing.isStopped) {
                updateMemoryQueueUI();
                throw new Error('ABORTED');
            }

            let entryUpdate = parseAIResponse(response);

            if (!entryUpdate || !entryUpdate[category] || !entryUpdate[category][entryName]) {
                if (entryUpdate && entryUpdate[category]) {
                    const keys = Object.keys(entryUpdate[category]);
                    if (keys.length === 1) {
                        const returnedEntry = entryUpdate[category][keys[0]];
                        entryUpdate[category] = { [entryName]: returnedEntry };
                    }
                }
            }

            if (entryUpdate && entryUpdate[category] && entryUpdate[category][entryName]) {
                if (!memory.result) {
                    memory.result = {};
                }
                if (!memory.result[category]) {
                    memory.result[category] = {};
                }

                memory.result[category][entryName] = entryUpdate[category][entryName];

                await MemoryHistoryDB.saveRollResult(memoryIndex, memory.result);
                await MemoryHistoryDB.saveEntryRollResult(
                    category,
                    entryName,
                    memoryIndex,
                    entryUpdate[category][entryName],
                    customPrompt,
                );

                if (!AppState.worldbook.generated[category]) {
                    AppState.worldbook.generated[category] = {};
                }
                AppState.worldbook.generated[category][entryName] = entryUpdate[category][entryName];

                updateStreamContent(`✅ 条目重Roll完成: [${category}] ${entryName}\n`);
                updateMemoryQueueUI();
                updateWorldbookPreview();

                return entryUpdate[category][entryName];
            }

            throw new Error('AI返回的结果格式不正确，请重试');
        } catch (error) {
            memory.processing = false;
            if (error.message !== 'ABORTED') {
                updateStreamContent(`❌ 条目重Roll失败: ${error.message}\n`);
            }
            updateMemoryQueueUI();
            throw error;
        } finally {
            if (manageStatus) {
                endRerollScope(ownsStatus);
            }
        }
    }

    async function handleRerollSingleEntryAcrossSources(options = {}) {
        const {
            category,
            entryName,
            memoryIndices = [],
            customPrompt = '',
            concurrency = 1,
            onProgress = () => {},
        } = options;

        if (!Array.isArray(memoryIndices) || memoryIndices.length === 0) {
            throw new Error('请至少选择一个来源章节');
        }

        const ownsStatus = beginRerollScope();
        const total = memoryIndices.length;
        let completed = 0;
        let failed = 0;
        let lastResult = null;

        onProgress({ completed, failed, total });

        try {
            await runWithConcurrency({
                items: memoryIndices,
                concurrency,
                shouldStop: () => AppState.processing.isStopped,
                runItem: async (memoryIndex) => {
                    try {
                        const result = await handleRerollSingleEntry({
                            memoryIndex,
                            category,
                            entryName,
                            customPrompt,
                            manageStatus: false,
                        });
                        lastResult = result;
                        completed += 1;
                    } catch (error) {
                        if (error.message !== 'ABORTED') {
                            failed += 1;
                        }
                    }
                    onProgress({ completed, failed, total });
                },
            });

            return {
                completed,
                failed,
                total,
                lastResult,
                stopped: AppState.processing.isStopped,
            };
        } finally {
            endRerollScope(ownsStatus);
        }
    }

    async function handleBatchRerollEntries(options = {}) {
        const {
            entries = [],
            customPrompt = '',
            concurrency = 1,
            onProgress = () => {},
        } = options;

        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error('请至少选择一个条目');
        }

        const ownsStatus = beginRerollScope();
        const total = entries.length;
        let completed = 0;
        let failed = 0;

        onProgress({ completed, failed, total });

        try {
            await runWithConcurrency({
                items: entries,
                concurrency,
                shouldStop: () => AppState.processing.isStopped,
                runItem: async ({ category, entryName }) => {
                    const sources = findEntrySourceMemories(category, entryName);
                    if (sources.length === 0) {
                        failed += 1;
                        onProgress({ completed, failed, total });
                        return;
                    }

                    try {
                        await handleRerollSingleEntry({
                            memoryIndex: sources[0].memoryIndex,
                            category,
                            entryName,
                            customPrompt,
                            manageStatus: false,
                        });
                        completed += 1;
                    } catch (error) {
                        if (error.message !== 'ABORTED') {
                            failed += 1;
                        }
                    }

                    onProgress({ completed, failed, total });
                },
            });

            return {
                completed,
                failed,
                total,
                stopped: AppState.processing.isStopped,
            };
        } finally {
            endRerollScope(ownsStatus);
        }
    }

    return {
        handleRerollMemory,
        findEntrySourceMemories,
        handleRerollSingleEntry,
        handleRerollSingleEntryAcrossSources,
        handleBatchRerollEntries,
        rerollMemory: handleRerollMemory,
        rerollSingleEntry: handleRerollSingleEntry,
    };
}
