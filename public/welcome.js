const status = document.getElementById('status');
const params = new URLSearchParams(location.search);
const port = Number(params.get('pair_port'));
const nonce = params.get('pair_nonce') || '';
const extensionId = typeof chrome?.runtime?.id === 'string' ? chrome.runtime.id : '';

async function pair() {
    if (!port || !nonce || !/^[a-p]{32}$/.test(extensionId)) {
        status.textContent = '配对链接无效；请从 actspan install 重新开始。';
        return;
    }
    try {
        const response = await fetch(`http://127.0.0.1:${port}/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-actspan-pairing': nonce },
            body: JSON.stringify({ extensionId }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        status.textContent = '扩展已交给本机安装器；可以关闭此页。';
    } catch {
        status.textContent = '本机安装器没有响应；请确认 install 仍在等待，然后重试。';
    }
}
void pair();
