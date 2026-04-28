export function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes/1048576).toFixed(1)} MB`;
  return `${(bytes/1073741824).toFixed(2)} GB`;
}
export function formatRelativeDate(unixTs) {
  if (!unixTs) return '—';
  const diff = Date.now()/1000 - unixTs;
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800)return `${Math.floor(diff/86400)}d ago`;
  return new Date(unixTs*1000).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
export function cleanFileName(name) {
  return (name||'').replace(/\.(pdf|epub)$/i,'').replace(/[-_]/g,' ').trim();
}
export function getInitials(name) {
  return cleanFileName(name).split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
}
export function stringToColor(str) {
  let h=0; for(let i=0;i<str.length;i++) h=str.charCodeAt(i)+((h<<5)-h);
  return `hsl(${Math.abs(h)%360},40%,40%)`;
}
