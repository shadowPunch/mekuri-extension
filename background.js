// Mekuri background: opens the reader from the toolbar button, a link's context menu, or automatically for every PDF.
const readerUrl = src => chrome.runtime.getURL('reader.html') + (src ? '?src=' + encodeURIComponent(src) : '');
const isPdfUrl = u => /^(https?|file):/i.test(u || '') && /\.pdf($|[?#])/i.test(u);
chrome.action.onClicked.addListener(tab => chrome.tabs.create({ url: readerUrl(tab && isPdfUrl(tab.url) ? tab.url : '') }));
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'mekuri-link', title: 'Open PDF link in Mekuri', contexts: ['link'] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener(info => { if (info.menuItemId === 'mekuri-link' && info.linkUrl) chrome.tabs.create({ url: readerUrl(info.linkUrl) }); });

// Default viewer: when a tab lands on a PDF, send that tab to the reader instead.
// Web PDFs are recognised by their content type (not the address); PDFs on disk by the .pdf ending.
// PDFs a site sends as downloads are left alone, and so is going Back to a PDF, so Back never traps you.
const byHeader = new Map();
chrome.webRequest.onHeadersReceived.addListener(d => {
  const h = n => ((d.responseHeaders || []).find(x => x.name.toLowerCase() === n) || {}).value || '';
  if (/^application\/pdf/i.test(h('content-type')) && !/attachment/i.test(h('content-disposition'))) byHeader.set(d.tabId, d.url);
  else byHeader.delete(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['responseHeaders']);
chrome.webNavigation.onCommitted.addListener(async d => {
  if (d.frameId !== 0) return;
  const hdr = byHeader.get(d.tabId) === d.url; byHeader.delete(d.tabId);
  if (!(hdr || (/^file:/i.test(d.url) && isPdfUrl(d.url)))) return;
  if ((d.transitionQualifiers || []).includes('forward_back')) return;
  const { intercept } = await chrome.storage.local.get({ intercept: true });
  if (intercept) chrome.tabs.update(d.tabId, { url: readerUrl(d.url) });
});
