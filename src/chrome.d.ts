// Minimal Chrome MV3 ambient declarations.
// Replace with @types/chrome once the package becomes available in the local registry.
// When adding @types/chrome: delete this file and restore "chrome" in tsconfig types[].

declare namespace chrome {
  namespace runtime {
    interface InstalledDetails { reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update'; previousVersion?: string; }
    interface MessageSender { tab?: tabs.Tab; frameId?: number; id?: string; url?: string; origin?: string; }
    interface LastError { message?: string; }
    type MessageListener = (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined | void;
    const lastError: LastError | undefined;
    const id: string;
    const onInstalled: { addListener(cb: (d: InstalledDetails) => void): void };
    const onStartup: { addListener(cb: () => void): void };
    const onMessage: { addListener(l: MessageListener): void; removeListener(l: MessageListener): void };
    const onConnect: { addListener(cb: (port: Port) => void): void };
    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(message: unknown, cb: (response: unknown) => void): void;
    function openOptionsPage(): Promise<void>;
    function getURL(path: string): string;
    function getManifest(): Record<string, unknown>;
    interface Port { name: string; disconnect(): void; postMessage(m: unknown): void; onMessage: { addListener(cb: (m: unknown) => void): void }; onDisconnect: { addListener(cb: () => void): void } }
  }

  namespace tabs {
    interface Tab { id?: number; url?: string; pendingUrl?: string; title?: string; active: boolean; windowId: number; status?: 'loading' | 'complete'; openerTabId?: number; index?: number; }
    interface QueryInfo { active?: boolean; currentWindow?: boolean; url?: string | string[]; }
    interface ChangeInfo { status?: string; url?: string; }
    interface TabActiveInfo { tabId: number; windowId: number; previousTabId?: number; }
    function query(info: QueryInfo): Promise<Tab[]>;
    function query(info: QueryInfo, cb: (tabs: Tab[]) => void): void;
    function get(tabId: number): Promise<Tab>;
    function captureVisibleTab(windowId: number, options?: { format?: 'jpeg' | 'png' | 'webp'; quality?: number }): Promise<string>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    const onUpdated: { addListener(cb: (tabId: number, changeInfo: ChangeInfo, tab: Tab) => void): void; removeListener(cb: (tabId: number, changeInfo: ChangeInfo, tab: Tab) => void): void };
    const onCreated: { addListener(cb: (tab: Tab) => void): void };
    const onRemoved: { addListener(cb: (tabId: number, info: { isWindowClosing: boolean }) => void): void; removeListener(cb: (tabId: number, info: { isWindowClosing: boolean }) => void): void };
    const onActivated: { addListener(cb: (info: TabActiveInfo) => void): void; removeListener(cb: (info: TabActiveInfo) => void): void };
  }

  namespace webRequest {
    interface RequestDetails { requestId: string; url: string; method: string; frameId: number; parentFrameId: number; tabId: number; type: ResourceType; timeStamp: number; initiator?: string; }
    interface HeadersReceivedDetails extends RequestDetails { statusCode: number; statusLine: string; responseHeaders?: HttpHeader[]; fromCache?: boolean; }
    interface CompletedDetails extends HeadersReceivedDetails { ip?: string; }
    interface ErrorDetails extends RequestDetails { error: string; fromCache?: boolean; }
    interface HttpHeader { name: string; value?: string; }
    type ResourceType = 'main_frame' | 'sub_frame' | 'stylesheet' | 'script' | 'image' | 'font' | 'object' | 'xmlhttprequest' | 'ping' | 'csp_report' | 'media' | 'websocket' | 'webbundle' | 'other';
    interface RequestFilter { urls: string[]; types?: ResourceType[]; tabId?: number; }
    const onBeforeRequest: { addListener(cb: (d: RequestDetails) => void, filter: RequestFilter, extraInfoSpec?: string[]): void; removeListener(cb: (d: RequestDetails) => void): void };
    const onSendHeaders: { addListener(cb: (d: RequestDetails & { requestHeaders?: HttpHeader[] }) => void, filter: RequestFilter, extraInfoSpec?: string[]): void };
    const onHeadersReceived: { addListener(cb: (d: HeadersReceivedDetails) => void, filter: RequestFilter, extraInfoSpec?: string[]): void; removeListener(cb: (d: HeadersReceivedDetails) => void): void };
    const onCompleted: { addListener(cb: (d: CompletedDetails) => void, filter: RequestFilter, extraInfoSpec?: string[]): void; removeListener(cb: (d: CompletedDetails) => void): void };
    const onErrorOccurred: { addListener(cb: (d: ErrorDetails) => void, filter: RequestFilter): void; removeListener(cb: (d: ErrorDetails) => void): void };
  }

  namespace webNavigation {
    interface FrameNavDetails { tabId: number; url: string; frameId: number; timeStamp: number; transitionType?: string; transitionQualifiers?: string[]; }
    interface CreatedNavigationTargetDetails { sourceTabId: number; sourceFrameId: number; sourceProcessId?: number; tabId: number; url: string; timeStamp: number; }
    const onCommitted: { addListener(cb: (d: FrameNavDetails) => void, filter?: { url: { urlMatches?: string }[] }): void; removeListener(cb: (d: FrameNavDetails) => void): void };
    const onHistoryStateUpdated: { addListener(cb: (d: FrameNavDetails) => void): void; removeListener(cb: (d: FrameNavDetails) => void): void };
    const onBeforeNavigate: { addListener(cb: (d: FrameNavDetails) => void): void; removeListener(cb: (d: FrameNavDetails) => void): void };
    const onCompleted: { addListener(cb: (d: FrameNavDetails) => void): void; removeListener(cb: (d: FrameNavDetails) => void): void };
    const onCreatedNavigationTarget: { addListener(cb: (d: CreatedNavigationTargetDetails) => void): void; removeListener(cb: (d: CreatedNavigationTargetDetails) => void): void };
  }

  namespace scripting {
    interface InjectionTarget { tabId: number; frameIds?: number[]; allFrames?: boolean; }
    interface ScriptInjection { target: InjectionTarget; files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[]; world?: 'ISOLATED' | 'MAIN'; injectImmediately?: boolean; }
    interface CSSInjection { target: InjectionTarget; files?: string[]; css?: string; }
    interface InjectionResult { frameId: number; result?: unknown; }
    interface RegisteredContentScript {
      id: string;
      js?: string[];
      css?: string[];
      matches: string[];
      excludeMatches?: string[];
      runAt?: 'document_start' | 'document_end' | 'document_idle';
      allFrames?: boolean;
      world?: 'ISOLATED' | 'MAIN';
      persistAcrossSessions?: boolean;
    }
    function executeScript(injection: ScriptInjection): Promise<InjectionResult[]>;
    function insertCSS(injection: CSSInjection): Promise<void>;
    function removeCSS(injection: CSSInjection): Promise<void>;
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  }

  namespace storage {
    interface StorageChange { oldValue?: unknown; newValue?: unknown; }
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: {
      addListener(cb: (changes: Record<string, StorageChange>, areaName: 'sync' | 'local' | 'managed' | 'session') => void): void;
      removeListener(cb: (changes: Record<string, StorageChange>, areaName: 'sync' | 'local' | 'managed' | 'session') => void): void;
    };
  }

  namespace permissions {
    interface Permissions { origins?: string[]; permissions?: string[]; }
    function request(permissions: Permissions): Promise<boolean>;
    function request(permissions: Permissions, cb: (granted: boolean) => void): void;
    function contains(permissions: Permissions): Promise<boolean>;
    function contains(permissions: Permissions, cb: (result: boolean) => void): void;
    function remove(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions, cb: (removed: boolean) => void): void;
    const onAdded: { addListener(cb: (p: Permissions) => void): void };
    const onRemoved: { addListener(cb: (p: Permissions) => void): void };
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string | [number,number,number,number]; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }

  namespace commands {
    const onCommand: { addListener(cb: (command: string) => void): void };
  }

  namespace sidePanel {
    interface PanelOptions { tabId?: number; path?: string; enabled?: boolean; }
    interface PanelBehavior { openPanelOnActionClick?: boolean; }
    interface OpenOptions { tabId?: number; windowId?: number; }
    function setOptions(options: PanelOptions): Promise<void>;
    function getOptions(options: { tabId?: number }): Promise<PanelOptions>;
    function setPanelBehavior(behavior: PanelBehavior): Promise<void>;
    function open(options: OpenOptions): Promise<void>;
  }

  namespace windows {
    interface Window { id?: number; focused: boolean; type?: string; state?: string; }
    function getLastFocused(options?: { populate?: boolean }): Promise<Window>;
    function get(windowId: number, options?: { populate?: boolean }): Promise<Window>;
    function getAll(options?: { populate?: boolean }): Promise<Window[]>;
    const WINDOW_ID_CURRENT: number;
  }
}
