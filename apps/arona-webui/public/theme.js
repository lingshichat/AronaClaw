function applyTheme(themeName) {
  if (themeName === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('openclaw-theme', themeName);
}

// 初始化主题
const savedTheme = localStorage.getItem('openclaw-theme') || 'dark';
applyTheme(savedTheme);

// 添加主题切换按钮
window.addEventListener('DOMContentLoaded', () => {
  const footer = document.querySelector('.sidebar-footer');
  if (footer) {
    const themeBtn = document.createElement('button');
    themeBtn.className = 'theme-switch-btn';

    const current = localStorage.getItem('openclaw-theme') || 'dark';
    themeBtn.innerHTML = current === 'dark'
      ? '<i class="fa-solid fa-sun"></i> 亮色模式'
      : '<i class="fa-solid fa-moon"></i> 暗色模式';

    themeBtn.addEventListener('click', () => {
      const current = localStorage.getItem('openclaw-theme') || 'dark';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme);

      themeBtn.innerHTML = newTheme === 'dark'
        ? '<i class="fa-solid fa-sun"></i> 亮色模式'
        : '<i class="fa-solid fa-moon"></i> 暗色模式';
    });

    const logoutWrap = footer.querySelector('.logout-wrap');
    if (logoutWrap) {
      footer.insertBefore(themeBtn, logoutWrap);
    } else {
      footer.appendChild(themeBtn);
    }
  }
});
