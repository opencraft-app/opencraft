(function () {
  document.querySelectorAll('.line__warning').forEach(function (warning) {
    var label = warning.querySelector('strong');
    if (!label) return;
    var text = label.textContent;
    warning.innerHTML = '<span class="line__warning-mark">⚠️</span><strong></strong>';
    warning.querySelector('strong').textContent = text;
    warning.dataset.fullHtml = '<span class="line__warning-mark">⚠️</span><strong>' + text + '</strong>';
  });

  // 左侧场景切换改为 hover 触发（见各页内联脚本），此处不再拦截滚轮进行切换，
  // 让该区域的滚轮回归正常的页面滚动。
})();
