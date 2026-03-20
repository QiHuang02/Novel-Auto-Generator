/**
 * Lightweight event delegation helpers.
 */
export const EventDelegate = {
    /**
     * Bind a delegated listener and return an unbind function.
     * @param {HTMLElement} container
     * @param {string} selector
     * @param {string} eventType
     * @param {(event: Event, target: HTMLElement) => void} handler
     * @returns {() => void}
     */
    on(container, selector, eventType, handler) {
        if (!container || !selector || !eventType || typeof handler !== 'function') {
            return () => {};
        }

        const delegateHandler = (event) => {
            const target = event.target?.closest(selector);
            if (target && container.contains(target)) {
                handler.call(target, event, target);
            }
        };

        container.addEventListener(eventType, delegateHandler);
        return () => container.removeEventListener(eventType, delegateHandler);
    },

    /**
     * Bind delegated listeners in batch.
     * @param {HTMLElement} container
     * @param {Record<string, Record<string, Function>>} config
     * @returns {() => void}
     */
    batchOn(container, config = {}) {
        const cleanups = [];
        for (const [selector, events] of Object.entries(config)) {
            for (const [eventType, handler] of Object.entries(events)) {
                cleanups.push(this.on(container, selector, eventType, handler));
            }
        }
        return () => cleanups.forEach((fn) => fn());
    },
};

