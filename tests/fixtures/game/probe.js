document.querySelector('#save').addEventListener('click', async () => {
  const output = document.querySelector('#result');
  try {
    localStorage.setItem('ashfall-probe', '本地桌面存档测试');
    await window.__ASHFALL_BRIDGE__.flush();
    output.textContent = '快照已确认落盘';
  } catch (error) { output.textContent = `保存失败：${error.message}`; }
});
