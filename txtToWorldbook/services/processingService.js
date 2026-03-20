export function createProcessingService(deps = {}) {
    const {
        AppState,
        MemoryHistoryDB,
        Semaphore,
        updateMemoryQueueUI = () => {},
        updateProgress = () => {},
        updateStreamContent = () => {},
        debugLog = () => {},
        callAPI,
        isTokenLimitError = () => false,
        parseAIResponse,
        postProcessResultWithChapterIndex = (value) => value,
        mergeWorldbookDataWithHistory = async () => [],
        getChapterForcePrompt = () => '',
        getLanguagePrefix = () => '',
        buildSystemPrompt = () => '',
        getPreviousMemoryContext = () => '',
        getEnabledCategories = () => [],
        splitMemoryIntoTwo = () => null,
        handleStartNewVolume = () => {},
        showProgressSection = () => {},
        updateStopButtonVisibility = () => {},
        updateVolumeIndicator = () => {},
        updateStartButtonState = () => {},
        showResultSection = () => {},
        updateWorldbookPreview = () => {},
        applyDefaultWorldbookEntries = () => false,
        ErrorHandler = {},
        handleRepairMemoryWithSplit,
        setProcessingStatus = () => {},
        getProcessingStatus = () => 'idle',
    } = deps;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function getQueueLength() {
        return Array.isArray(AppState?.memory?.queue) ? AppState.memory.queue.length : 0;
    }

    function getConcurrency() {
        return Math.max(1, Number(AppState?.config?.parallel?.concurrency) || 1);
    }

    function ensureSemaphoreCtor() {
        if (typeof Semaphore !== 'function') {
            throw new Error('Semaphore 未注入，无法执行并行处理');
        }
    }

    async function processMemoryChunkIndependent(options = {}) {
        const { index, retryCount = 0, customPromptSuffix = '' } = options;
        const memory = AppState?.memory?.queue?.[index];
        if (!memory) {
            throw new Error(`找不到记忆块: ${index}`);
        }

        const maxRetries = 3;
        const taskId = index + 1;
        const chapterIndex = index + 1;

        if (!AppState.processing.isRerolling && AppState.processing.isStopped) {
            throw new Error('ABORTED');
        }

        memory.processing = true;
        updateMemoryQueueUI();

        const chapterForcePrompt = AppState.settings.forceChapterMarker
            ? getChapterForcePrompt(chapterIndex)
            : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix();
        prompt += buildSystemPrompt();

        const prevContext = getPreviousMemoryContext(index);
        if (prevContext) {
            prompt += prevContext;
        }

        if (index > 0 && AppState.memory.queue[index - 1]?.content) {
            prompt += `\n\n前文结尾（供参考）：\n---\n${AppState.memory.queue[index - 1].content.slice(-800)}\n---\n`;
        }

        prompt += `\n\n当前需要分析的内容（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        const enabledCategoryNames = getEnabledCategories().map((item) => item.name);
        if (AppState.settings.enablePlotOutline) enabledCategoryNames.push('剧情大纲');
        if (AppState.settings.enableLiteraryStyle) enabledCategoryNames.push('文风配置');

        if (enabledCategoryNames.length > 0) {
            prompt += `\n\n【输出限制】只允许输出以下分类：${enabledCategoryNames.join('、')}。禁止输出未列出的任何其他分类，直接输出JSON。`;
        }

        if (AppState.settings.forceChapterMarker) {
            prompt += `\n\n【重要提醒】如果输出剧情大纲或剧情节点或章节剧情，条目名称必须包含"第${chapterIndex}章"！`;
            prompt += chapterForcePrompt;
        }

        if (customPromptSuffix) {
            prompt += `\n\n${customPromptSuffix}`;
        }

        if (AppState.settings.customSuffixPrompt?.trim()) {
            prompt += `\n\n${AppState.settings.customSuffixPrompt.trim()}`;
        }

        updateStreamContent(`\n🔄 [第${chapterIndex}章] 开始处理: ${memory.title}\n`);
        debugLog(`[第${chapterIndex}章] 开始, prompt长度=${prompt.length}字符, 重试=${retryCount}`);

        try {
            debugLog(`[第${chapterIndex}章] 调用API...`);
            const response = await callAPI(prompt, taskId);

            if (!AppState.processing.isRerolling && AppState.processing.isStopped) {
                memory.processing = false;
                throw new Error('ABORTED');
            }

            debugLog(`[第${chapterIndex}章] 检查TokenLimit...`);
            if (isTokenLimitError(response)) {
                throw new Error('Token limit exceeded');
            }

            debugLog(`[第${chapterIndex}章] 解析AI响应...`);
            let memoryUpdate = parseAIResponse(response);

            debugLog(`[第${chapterIndex}章] 后处理章节索引...`);
            memoryUpdate = postProcessResultWithChapterIndex(memoryUpdate, chapterIndex);

            debugLog(`[第${chapterIndex}章] 处理完成`);
            updateStreamContent(`✅ [第${chapterIndex}章] 处理完成\n`);
            return memoryUpdate;
        } catch (error) {
            memory.processing = false;
            if (error.message === 'ABORTED') {
                throw error;
            }

            updateStreamContent(`❌ [第${chapterIndex}章] 错误: ${error.message}\n`);

            if (isTokenLimitError(error.message || '')) {
                throw new Error(`TOKEN_LIMIT:${index}`);
            }

            if (retryCount < maxRetries && !AppState.processing.isStopped) {
                const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateStreamContent(`🔄 [第${chapterIndex}章] ${delay / 1000}秒后重试...\n`);
                await sleep(delay);
                return processMemoryChunkIndependent({
                    index,
                    retryCount: retryCount + 1,
                    customPromptSuffix,
                });
            }

            throw error;
        }
    }

    async function processMemoryChunksParallel(startIndex, endIndex) {
        ensureSemaphoreCtor();

        const tasks = [];
        const results = new Map();
        const tokenLimitIndices = [];

        for (let i = startIndex; i < endIndex && i < AppState.memory.queue.length; i += 1) {
            if (AppState.memory.queue[i].processed && !AppState.memory.queue[i].failed) {
                continue;
            }
            tasks.push({ index: i, memory: AppState.memory.queue[i] });
        }

        if (tasks.length === 0) {
            return { tokenLimitIndices };
        }

        const concurrency = getConcurrency();

        updateStreamContent(`
🚀 并行处理 ${tasks.length} 个记忆块 (并发: ${concurrency})
${'='.repeat(50)}
`);
        debugLog(`并行处理开始: ${tasks.length}任务, 并发=${concurrency}, 范围=${startIndex}-${endIndex}`);

        let completed = 0;
        AppState.globalSemaphore = new Semaphore(concurrency);

        const processOne = async (task) => {
            if (AppState.processing.isStopped) {
                return null;
            }

            try {
                await AppState.globalSemaphore.acquire();
            } catch (error) {
                if (error.message === 'ABORTED') {
                    return null;
                }
                throw error;
            }

            if (AppState.processing.isStopped) {
                AppState.globalSemaphore.release();
                return null;
            }

            AppState.processing.activeTasks.add(task.index);

            try {
                debugLog(`[任务${task.index + 1}] 获取信号量成功, 开始处理`);
                updateProgress(
                    ((startIndex + completed) / Math.max(getQueueLength(), 1)) * 100,
                    `🚀 并行处理中 (${completed}/${tasks.length})`,
                );

                const result = await processMemoryChunkIndependent({ index: task.index });
                completed += 1;

                if (result) {
                    results.set(task.index, result);
                }

                updateMemoryQueueUI();
                return result;
            } catch (error) {
                completed += 1;
                task.memory.processing = false;

                if (error.message === 'ABORTED') {
                    updateMemoryQueueUI();
                    return null;
                }

                if (error.message.startsWith('TOKEN_LIMIT:')) {
                    tokenLimitIndices.push(Number.parseInt(error.message.split(':')[1], 10));
                } else {
                    task.memory.failed = true;
                    task.memory.failedError = error.message;
                    task.memory.processed = true;
                }

                updateMemoryQueueUI();
                return null;
            } finally {
                AppState.processing.activeTasks.delete(task.index);
                AppState.globalSemaphore.release();
            }
        };

        await Promise.allSettled(tasks.map((task) => processOne(task)));
        AppState.processing.activeTasks.clear();
        AppState.globalSemaphore = null;

        const orderedTasks = tasks
            .filter((task) => results.has(task.index))
            .sort((a, b) => a.index - b.index);

        for (const task of orderedTasks) {
            const result = results.get(task.index);
            task.memory.processed = true;
            task.memory.failed = false;
            task.memory.processing = false;
            task.memory.result = result;
            await mergeWorldbookDataWithHistory({
                target: AppState.worldbook.generated,
                source: result,
                memoryIndex: task.index,
                memoryTitle: task.memory.title,
            });
            await MemoryHistoryDB.saveRollResult(task.index, result);
        }

        updateMemoryQueueUI();
        updateStreamContent(`
${'='.repeat(50)}
📦 并行处理完成，成功: ${results.size}/${tasks.length}
`);
        return { tokenLimitIndices };
    }

    async function processMemoryChunk(index, retryCount = 0) {
        if (AppState.processing.isStopped) {
            return;
        }

        const memory = AppState.memory.queue[index];
        if (!memory) {
            return;
        }

        const progress = ((index + 1) / Math.max(getQueueLength(), 1)) * 100;
        const maxRetries = 3;
        const chapterIndex = index + 1;

        debugLog(`[串行][第${chapterIndex}章] 开始, 重试=${retryCount}`);
        updateProgress(
            progress,
            `正在处理: ${memory.title} (第${chapterIndex}章)${retryCount > 0 ? ` (重试 ${retryCount})` : ''}`,
        );

        memory.processing = true;
        updateMemoryQueueUI();

        const chapterForcePrompt = AppState.settings.forceChapterMarker
            ? getChapterForcePrompt(chapterIndex)
            : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix();
        prompt += buildSystemPrompt();

        const prevContext = getPreviousMemoryContext(index);
        if (prevContext) {
            prompt += prevContext;
        }

        if (index > 0) {
            prompt += `\n\n上次阅读结尾：\n---\n${AppState.memory.queue[index - 1].content.slice(-500)}\n---\n`;
            prompt += `\n当前世界书：\n${JSON.stringify(AppState.worldbook.generated, null, 2)}\n`;
        }

        prompt += `\n现在阅读的部分（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        if (index === 0 || index === AppState.memory.startIndex) {
            prompt += `\n请开始分析小说内容。`;
        } else if (AppState.processing.incrementalMode) {
            prompt += `\n请增量更新世界书，只输出变更的条目。`;
        } else {
            prompt += `\n请累积补充世界书。`;
        }

        if (AppState.settings.forceChapterMarker) {
            prompt += `\n\n【重要提醒】如果输出剧情大纲或剧情节点或章节剧情，条目名称必须包含"第${chapterIndex}章"！`;
            prompt += `\n直接输出JSON格式结果。`;
            prompt += chapterForcePrompt;
        } else {
            prompt += `\n直接输出JSON格式结果。`;
        }

        try {
            debugLog(`[串行][第${chapterIndex}章] 调用API, prompt长度=${prompt.length}`);
            const response = await callAPI(prompt);
            memory.processing = false;

            if (AppState.processing.isStopped) {
                updateMemoryQueueUI();
                return;
            }

            debugLog(`[串行][第${chapterIndex}章] 检查TokenLimit...`);
            if (isTokenLimitError(response)) {
                if (AppState.processing.volumeMode) {
                    handleStartNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await processMemoryChunk(index, 0);
                    return;
                }

                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }

            debugLog(`[串行][第${chapterIndex}章] 解析AI响应...`);
            let memoryUpdate = parseAIResponse(response);
            memoryUpdate = postProcessResultWithChapterIndex(memoryUpdate, chapterIndex);

            debugLog(`[串行][第${chapterIndex}章] 合并世界书...`);
            await mergeWorldbookDataWithHistory({
                target: AppState.worldbook.generated,
                source: memoryUpdate,
                memoryIndex: index,
                memoryTitle: memory.title,
            });

            debugLog(`[串行][第${chapterIndex}章] 保存Roll结果...`);
            await MemoryHistoryDB.saveRollResult(index, memoryUpdate);
            debugLog(`[串行][第${chapterIndex}章] 完成`);

            memory.processed = true;
            memory.result = memoryUpdate;
            updateMemoryQueueUI();
        } catch (error) {
            memory.processing = false;

            if (isTokenLimitError(error.message || '')) {
                if (AppState.processing.volumeMode) {
                    handleStartNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await sleep(500);
                    await processMemoryChunk(index, 0);
                    return;
                }

                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
                    await sleep(500);
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }

            if (retryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateProgress(progress, `处理失败，${retryDelay / 1000}秒后重试`);
                await sleep(retryDelay);
                return processMemoryChunk(index, retryCount + 1);
            }

            memory.processed = true;
            memory.failed = true;
            memory.failedError = error.message;

            if (!AppState.memory.failedQueue.find((item) => item.index === index)) {
                AppState.memory.failedQueue.push({ index, memory, error: error.message });
            }

            updateMemoryQueueUI();
        }

        if (memory.processed) {
            await sleep(1000);
        }
    }

    function handleStopProcessing() {
        setProcessingStatus('stopped');

        if (AppState.globalSemaphore) {
            AppState.globalSemaphore.abort();
        }

        AppState.processing.activeTasks.clear();
        AppState.memory.queue.forEach((memory) => {
            if (memory.processing) {
                memory.processing = false;
            }
        });

        updateMemoryQueueUI();
        updateStreamContent(`\n⏸️ 已暂停\n`);
        updateStopButtonVisibility(true);
    }

    async function handleStartProcessing() {
        showProgressSection(true);
        setProcessingStatus('running');
        updateStopButtonVisibility(true);

        if (AppState.globalSemaphore) {
            AppState.globalSemaphore.reset();
        }
        AppState.processing.activeTasks.clear();

        updateStreamContent('', true);

        const enabledCatNames = getEnabledCategories().map((item) => item.name).join(', ');
        const chainDesc = (AppState.settings.promptMessageChain || []).filter((item) => item.enabled !== false);
        const chainSummary = chainDesc.length <= 1
            ? '默认(单条用户消息)'
            : `${chainDesc.length}条消息[${chainDesc.map((item) => (
                item.role === 'system' ? '系统' : item.role === 'assistant' ? 'AI' : '用户'
            )).join('→')}]`;

        updateStreamContent(
            `🚀 开始处理...\n`
            + `📊 处理模式: ${AppState.config.parallel.enabled ? `并行 (${getConcurrency()}并发)` : '串行'}\n`
            + `🔧 API模式: ${AppState.settings.useTavernApi ? '酒馆API' : `自定义API (${AppState.settings.customApiProvider})`}\n`
            + `📌 强制章节标记: ${AppState.settings.forceChapterMarker ? '开启' : '关闭'}\n`
            + `💬 消息链: ${chainSummary}\n`
            + `🏷️ 启用分类: ${enabledCatNames}\n`
            + `${'='.repeat(50)}\n`,
        );
        debugLog(`调试模式已开启 - 将记录每步耗时`);

        const effectiveStartIndex = AppState.memory.userSelectedIndex !== null
            ? AppState.memory.userSelectedIndex
            : AppState.memory.startIndex;

        if (effectiveStartIndex === 0) {
            const hasProcessedMemories = AppState.memory.queue.some(
                (memory) => memory.processed && !memory.failed && memory.result,
            );

            if (!hasProcessedMemories) {
                AppState.worldbook.volumes = [];
                AppState.worldbook.currentVolumeIndex = 0;
                AppState.worldbook.generated = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
                applyDefaultWorldbookEntries();
            }
        }

        AppState.memory.userSelectedIndex = null;

        if (AppState.processing.volumeMode) {
            updateVolumeIndicator();
        }

        updateStartButtonState(true);

        try {
            if (AppState.config.parallel.enabled) {
                if (AppState.config.parallel.mode === 'independent') {
                    const { tokenLimitIndices } = await processMemoryChunksParallel(
                        effectiveStartIndex,
                        AppState.memory.queue.length,
                    );

                    if (AppState.processing.isStopped) {
                        const processedCount = AppState.memory.queue.filter((memory) => memory.processed).length;
                        updateProgress(
                            (processedCount / Math.max(getQueueLength(), 1)) * 100,
                            `⏸️ 已暂停`,
                        );
                        await MemoryHistoryDB.saveState(processedCount);
                        updateStartButtonState(false);
                        return;
                    }

                    if (tokenLimitIndices.length > 0) {
                        for (const idx of [...tokenLimitIndices].sort((a, b) => b - a)) {
                            splitMemoryIntoTwo(idx);
                        }

                        updateMemoryQueueUI();

                        for (let i = 0; i < AppState.memory.queue.length; i += 1) {
                            if (AppState.processing.isStopped) break;
                            if (!AppState.memory.queue[i].processed || AppState.memory.queue[i].failed) {
                                await processMemoryChunk(i);
                            }
                        }
                    }
                } else {
                    const batchSize = getConcurrency();
                    let i = effectiveStartIndex;

                    while (i < AppState.memory.queue.length && !AppState.processing.isStopped) {
                        const batchEnd = Math.min(i + batchSize, AppState.memory.queue.length);
                        const { tokenLimitIndices } = await processMemoryChunksParallel(i, batchEnd);

                        if (AppState.processing.isStopped) break;

                        for (const idx of [...tokenLimitIndices].sort((a, b) => b - a)) {
                            splitMemoryIntoTwo(idx);
                        }

                        for (
                            let j = i;
                            j < batchEnd && j < AppState.memory.queue.length && !AppState.processing.isStopped;
                            j += 1
                        ) {
                            if (!AppState.memory.queue[j].processed || AppState.memory.queue[j].failed) {
                                await processMemoryChunk(j);
                            }
                        }

                        i = batchEnd;
                        await MemoryHistoryDB.saveState(i);
                    }
                }
            } else {
                let i = effectiveStartIndex;

                while (i < AppState.memory.queue.length) {
                    if (AppState.processing.isStopped) {
                        updateProgress(
                            (i / Math.max(getQueueLength(), 1)) * 100,
                            `⏸️ 已暂停`,
                        );
                        await MemoryHistoryDB.saveState(i);
                        updateStartButtonState(false);
                        return;
                    }

                    if (AppState.memory.queue[i].processed && !AppState.memory.queue[i].failed) {
                        i += 1;
                        continue;
                    }

                    const currentLength = AppState.memory.queue.length;
                    await processMemoryChunk(i);

                    if (AppState.memory.queue.length > currentLength) {
                        i += (AppState.memory.queue.length - currentLength);
                    }

                    i += 1;
                    await MemoryHistoryDB.saveState(i);
                }
            }

            if (AppState.processing.isStopped) {
                const processedCount = AppState.memory.queue.filter((memory) => memory.processed).length;
                updateProgress(
                    (processedCount / Math.max(getQueueLength(), 1)) * 100,
                    `⏸️ 已暂停`,
                );
                await MemoryHistoryDB.saveState(processedCount);
                updateStartButtonState(false);
                return;
            }

            if (AppState.processing.volumeMode && Object.keys(AppState.worldbook.generated).length > 0) {
                AppState.worldbook.volumes.push({
                    volumeIndex: AppState.worldbook.currentVolumeIndex,
                    worldbook: JSON.parse(JSON.stringify(AppState.worldbook.generated)),
                    timestamp: Date.now(),
                });
            }

            const failedCount = AppState.memory.queue.filter((memory) => memory.failed).length;
            if (failedCount > 0) {
                updateProgress(100, `⚠️ 完成，但有 ${failedCount} 个失败`);
            } else {
                updateProgress(100, `✅ 全部完成！`);
            }

            showResultSection(true);
            updateWorldbookPreview();
            updateStreamContent(`\n${'='.repeat(50)}\n✅ 处理完成！\n`);

            await MemoryHistoryDB.saveState(AppState.memory.queue.length);
            await MemoryHistoryDB.clearState();
            updateStartButtonState(false);

            if (getProcessingStatus() !== 'stopped') {
                setProcessingStatus('idle');
                updateStopButtonVisibility(false);
            }
        } catch (error) {
            if (typeof ErrorHandler?.handle === 'function') {
                ErrorHandler.handle(error, 'startAIProcessing');
            }

            updateProgress(0, `❌ 出错: ${error.message}`);
            updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            updateStartButtonState(false);

            if (getProcessingStatus() !== 'stopped') {
                setProcessingStatus('idle');
                updateStopButtonVisibility(false);
            }
        }
    }

    async function handleRepairFailedMemories() {
        const failedMemories = AppState.memory.queue.filter((memory) => memory.failed);
        if (failedMemories.length === 0) {
            if (typeof ErrorHandler?.showUserError === 'function') {
                ErrorHandler.showUserError('没有需要修复的记忆');
            }
            return;
        }

        setProcessingStatus('repairing');

        showProgressSection(true);
        updateStopButtonVisibility(true);
        updateProgress(0, `修复中 (0/${failedMemories.length})`);

        const stats = { successCount: 0, stillFailedCount: 0 };

        for (let i = 0; i < failedMemories.length; i += 1) {
            if (AppState.processing.isStopped) break;

            const memory = failedMemories[i];
            const memoryIndex = AppState.memory.queue.indexOf(memory);
            if (memoryIndex === -1) continue;

            updateProgress(
                ((i + 1) / Math.max(failedMemories.length, 1)) * 100,
                `修复: ${memory.title}`,
            );
            await handleRepairMemoryWithSplit(memoryIndex, stats);
        }

        AppState.memory.failedQueue = AppState.memory.failedQueue.filter(
            (item) => AppState.memory.queue[item.index]?.failed,
        );

        updateProgress(100, `修复完成: 成功 ${stats.successCount}, 仍失败 ${stats.stillFailedCount}`);
        await MemoryHistoryDB.saveState(AppState.memory.queue.length);

        if (getProcessingStatus() !== 'stopped') {
            setProcessingStatus('idle');
            updateStopButtonVisibility(false);
        }

        if (typeof ErrorHandler?.showUserSuccess === 'function') {
            ErrorHandler.showUserSuccess(
                `修复完成！成功: ${stats.successCount}, 仍失败: ${stats.stillFailedCount}`,
            );
        }

        updateMemoryQueueUI();
    }

    return {
        processMemoryChunkIndependent,
        processMemoryChunksParallel,
        processMemoryChunk,
        handleStopProcessing,
        handleStartProcessing,
        handleRepairFailedMemories,
        startProcessing: handleStartProcessing,
        stopProcessing: handleStopProcessing,
        repairFailed: handleRepairFailedMemories,
    };
}
