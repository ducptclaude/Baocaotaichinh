document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('error');
  const btn = e.target.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: e.target.username.value, password: e.target.password.value })
    });
    if (res.ok) return (location.href = '/');
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Đăng nhập thất bại (' + res.status + ')';
  } catch {
    err.textContent = 'Không kết nối được máy chủ';
  } finally {
    btn.disabled = false;
  }
});
