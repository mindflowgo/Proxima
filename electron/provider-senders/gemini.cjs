const INPUT_SELECTORS = [
    'rich-textarea .ql-editor',
    '.ql-editor[role="textbox"]',
    'rich-textarea [contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-label*="Gemini"]',
    'textarea[aria-label*="message"]',
    'textarea',
    'input[type="text"]'
];

const SEND_BUTTON_SELECTORS = [
    'button.send-button',
    'button.submit',
    'button[aria-label*="Send"]',
    'button[aria-label*="Enviar"]'
];

function buildFocusScript() {
    return `
        (function() {
            const selectors = ${JSON.stringify(INPUT_SELECTORS)};

            for (const selector of selectors) {
                const input = document.querySelector(selector);
                if (!input) continue;

                input.focus();
                input.click();

                return {
                    ready: true,
                    selector,
                    tagName: input.tagName,
                    isContentEditable: input.contentEditable === 'true' || input.isContentEditable,
                    textPreview: (input.value || input.innerText || input.textContent || '').trim().slice(0, 120)
                };
            }

            return { ready: false, error: 'No Gemini input found' };
        })()
    `;
}

function buildStateScript() {
    return `
        (function() {
            const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
            const buttonSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            let input = null;
            let inputSelector = '';
            for (const selector of inputSelectors) {
                input = document.querySelector(selector);
                if (input) {
                    inputSelector = selector;
                    break;
                }
            }

            let sendButton = null;
            let sendButtonSelector = '';
            for (const selector of buttonSelectors) {
                sendButton = document.querySelector(selector);
                if (sendButton) {
                    sendButtonSelector = selector;
                    break;
                }
            }

            const className = String(sendButton?.className || '');
            const disabled = !!sendButton &&
                (!!sendButton.disabled ||
                    sendButton.hasAttribute('disabled') ||
                    sendButton.getAttribute('aria-disabled') === 'true' ||
                    className.includes('disabled'));

            return {
                inputSelector,
                textPreview: (input?.value || input?.innerText || input?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
                sendButtonFound: !!sendButton,
                sendButtonSelector,
                sendButtonVisible: isVisible(sendButton),
                sendButtonDisabled: disabled,
                sendButtonAria: sendButton?.getAttribute('aria-label') || '',
                sendButtonClass: className.slice(0, 160)
            };
        })()
    `;
}

function buildClickScript() {
    return `
        (function() {
            const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
            };

            for (const selector of selectors) {
                const sendButton = document.querySelector(selector);
                if (!sendButton) continue;

                const className = String(sendButton.className || '');
                const disabled = !!sendButton.disabled ||
                    sendButton.hasAttribute('disabled') ||
                    sendButton.getAttribute('aria-disabled') === 'true' ||
                    className.includes('disabled');

                if (disabled || !isVisible(sendButton)) {
                    return {
                        clicked: false,
                        selector,
                        reason: disabled ? 'Send button disabled' : 'Send button not visible',
                        ariaLabel: sendButton.getAttribute('aria-label') || '',
                        className: className.slice(0, 160)
                    };
                }

                sendButton.click();
                return {
                    clicked: true,
                    selector,
                    ariaLabel: sendButton.getAttribute('aria-label') || '',
                    className: className.slice(0, 160)
                };
            }

            return { clicked: false, reason: 'No send button found' };
        })()
    `;
}

async function focusGeminiInput(webContents) {
    return webContents.executeJavaScript(buildFocusScript());
}

async function getGeminiComposerState(webContents) {
    return webContents.executeJavaScript(buildStateScript());
}

async function clearFocusedInput(webContents, runtime, modifier) {
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] });
    await runtime.sleep(60);
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await runtime.sleep(120);
}

async function typeWithNativeInsert(webContents, message) {
    if (typeof webContents.insertText !== 'function') {
        return { ok: false, method: 'native-insert-unavailable' };
    }

    await Promise.resolve(webContents.insertText(message));
    return { ok: true, method: 'native-insertText' };
}

async function typeWithClipboardPaste(webContents, runtime, message, modifier) {
    const previousClipboard = runtime.clipboard.readText();
    runtime.clipboard.writeText(message);

    try {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [modifier] });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [modifier] });
        await runtime.sleep(180);
    } finally {
        runtime.clipboard.writeText(previousClipboard);
    }

    return { ok: true, method: 'clipboard-paste' };
}

module.exports = async function sendToGemini({ webContents, message, runtime }) {
    console.log('[Gemini] Sending message...');

    const previousState = await runtime.capturePreviousResponse('gemini', { force: true });
    const previousFingerprint = previousState.fingerprint || '';
    const shortcutModifier = process.platform === 'darwin' ? 'meta' : 'control';

    console.log('[Gemini] Captured old response fingerprint:', previousFingerprint.substring(0, 50) + '...');

    const focusResult = await focusGeminiInput(webContents);
    console.log('[Gemini] Focus result:', focusResult);

    if (!focusResult?.ready) {
        return { sent: false, error: focusResult?.error || 'No Gemini input found' };
    }

    await clearFocusedInput(webContents, runtime, shortcutModifier);

    let inputMethod = 'native-insertText';
    let typeResult = await typeWithNativeInsert(webContents, message);
    await runtime.sleep(250);

    let composerState = await getGeminiComposerState(webContents);
    console.log('[Gemini] Composer state after native insert:', composerState);

    if (!composerState.sendButtonFound || composerState.sendButtonDisabled || !composerState.sendButtonVisible) {
        console.log('[Gemini] Native insert did not enable send button, retrying with clipboard paste...');

        await focusGeminiInput(webContents);
        await clearFocusedInput(webContents, runtime, shortcutModifier);

        typeResult = await typeWithClipboardPaste(webContents, runtime, message, shortcutModifier);
        inputMethod = typeResult.method;
        await runtime.sleep(250);

        composerState = await getGeminiComposerState(webContents);
        console.log('[Gemini] Composer state after clipboard paste:', composerState);
    }

    const clickScript = buildClickScript();
    let clickResult = null;

    for (let attempt = 0; attempt < 15; attempt++) {
        clickResult = await webContents.executeJavaScript(clickScript);
        if (clickResult?.clicked) {
            break;
        }

        await runtime.sleep(200);
    }

    console.log('[Gemini] Click result:', clickResult);

    if (!clickResult?.clicked) {
        await focusGeminiInput(webContents);
        await runtime.sleep(100);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return {
        sent: true,
        method: inputMethod,
        compose: composerState,
        submit: clickResult || { clicked: false, reason: 'Used Enter fallback' }
    };
};
