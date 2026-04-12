module.exports = async function sendToMetaAI({ webContents, message, runtime }) {
    const previousState = await runtime.capturePreviousResponse('metaai', { force: true });
    const previousFingerprint = previousState.fingerprint || '';

    console.log('[Meta AI] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const prepared = await webContents.executeJavaScript(`
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const input = document.querySelector('[data-testid="composer-input"][contenteditable="true"]') ||
                document.querySelector('[role="textbox"][data-testid="composer-input"]') ||
                document.querySelector('[role="textbox"][contenteditable="true"]') ||
                document.querySelector('[contenteditable="true"][data-testid="composer-input"]') ||
                document.querySelector('[contenteditable="true"]') ||
                document.querySelector('input[placeholder*="Meta AI"]') ||
                document.querySelector('input[type="text"]');

            if (!input || !isVisible(input)) {
                return { ready: false, error: 'No Meta AI input found' };
            }

            input.focus();
            input.click();

            if (input.matches('[contenteditable="true"], [role="textbox"]')) {
                const selection = window.getSelection();
                if (selection) {
                    selection.removeAllRanges();
                    const range = document.createRange();
                    range.selectNodeContents(input);
                    range.collapse(true);
                    selection.addRange(range);
                }

                try {
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                } catch (error) {}

                input.innerHTML = '';

                let inserted = false;
                try {
                    inserted = document.execCommand('insertText', false, ${JSON.stringify(message)});
                } catch (error) {}

                if (!inserted) {
                    input.textContent = ${JSON.stringify(message)};
                }

                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: ${JSON.stringify(message)}
                }));
            } else {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (!setter) {
                    return { ready: false, error: 'Input value setter unavailable' };
                }

                setter.call(input, '');
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'deleteContentBackward',
                    data: null
                }));

                setter.call(input, ${JSON.stringify(message)});
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: ${JSON.stringify(message)}
                }));
            }

            input.dispatchEvent(new Event('change', { bubbles: true }));

            return {
                ready: true,
                selector: input.getAttribute('data-testid') || input.getAttribute('role') || input.tagName,
                textPreview: (input.value || input.innerText || input.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
            };
        })()
    `);

    console.log('[Meta AI] Prepare result:', prepared);

    if (!prepared?.ready) {
        return { sent: false, error: prepared?.error || 'Failed to prepare Meta AI input' };
    }

    const clickScript = `
        (function() {
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            const selectors = [
                '[data-testid="composer-send-button"]',
                'button[aria-label="Send"]',
                'button[aria-label*="Send"]'
            ];

            const candidates = [];

            for (const selector of selectors) {
                const sendButton = document.querySelector(selector);
                if (!sendButton) continue;

                const ariaDisabled = sendButton.getAttribute('aria-disabled');
                const disabled = !!sendButton.disabled ||
                    sendButton.hasAttribute('disabled') ||
                    ariaDisabled === 'true';

                candidates.push({
                    selector,
                    ariaLabel: sendButton.getAttribute('aria-label') || '',
                    dataTestId: sendButton.getAttribute('data-testid') || '',
                    visible: isVisible(sendButton),
                    disabled
                });

                if (!disabled && isVisible(sendButton)) {
                    sendButton.click();
                    return {
                        clicked: true,
                        selector,
                        ariaLabel: sendButton.getAttribute('aria-label') || '',
                        dataTestId: sendButton.getAttribute('data-testid') || ''
                    };
                }
            }

            return {
                clicked: false,
                reason: candidates.length > 0 ? 'Send button still disabled or hidden' : 'No send button found',
                candidates
            };
        })()
    `;

    let clickResult = null;
    for (let attempt = 0; attempt < 15; attempt++) {
        clickResult = await webContents.executeJavaScript(clickScript);
        if (clickResult?.clicked) {
            break;
        }

        await runtime.sleep(200);
    }

    console.log('[Meta AI] Click result:', clickResult);

    if (!clickResult?.clicked) {
        await webContents.executeJavaScript(`
            (function() {
                const input = document.querySelector('[data-testid="composer-input"][contenteditable="true"]') ||
                    document.querySelector('[role="textbox"][data-testid="composer-input"]') ||
                    document.querySelector('[role="textbox"][contenteditable="true"]') ||
                    document.querySelector('[contenteditable="true"]');
                if (input) {
                    input.focus();
                    input.click();
                }
            })()
        `);

        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return {
        sent: true,
        submit: clickResult || { clicked: false, reason: 'Used Enter fallback' }
    };
};
