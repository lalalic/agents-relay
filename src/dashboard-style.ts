import { readFileSync } from 'node:fs';
/** Legacy Node/Rust byte-for-byte stylesheet parity fixture; source is a standalone PWA asset. */
export const dashboardStyles = '  <style>' + readFileSync(new URL('../dashboard/dashboard.css', import.meta.url), 'utf8') + '</style>';
