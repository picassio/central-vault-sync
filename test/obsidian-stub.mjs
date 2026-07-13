export class TAbstractFile { constructor(path = '') { this.path = path; this.name = path.split('/').at(-1) ?? ''; } }
export class TFile extends TAbstractFile { constructor(path) { super(path); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.stat = { size: 0, mtime: 0, ctime: 0 }; } }
export class TFolder extends TAbstractFile {}
export const normalizePath = (value) => value.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
export const Platform = { isDesktop: false, isMobile: true, isMobileApp: true, isIosApp: false, isAndroidApp: true };
export async function requestUrl() { throw new Error('requestUrl test stub was not configured'); }
export class Modal {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
