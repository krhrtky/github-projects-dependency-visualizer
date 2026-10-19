import type { Dependency } from '../domain/graph';
import { issueKey } from '../domain/issue';
import { MAX_ISSUES, isProjectUrl } from '../shared/config';
import { send, type IssueResult, type PageStatus, type Settings } from '../shared/messages';
import { SvgRenderer } from '../renderer/svg-renderer';
import { RelationshipControls } from '../renderer/relationship-controls';
import { detectProjectView, type ProjectView } from './board-detector';
import { extractCards, projectViewRect } from './card-extractor';
import { BoardObserver, isExternalMutation } from './board-observer';
export class Controller {
  private settings: Settings = { enabled: false, authenticated: false, relationshipsVisible: true };
  private view: ProjectView | null = null;
  private observer?: BoardObserver;
  private readonly renderer = new SvgRenderer();
  private readonly relationships = new RelationshipControls(() => this.refreshRelationships());
  private readonly results = new Map<string, IssueResult>();
  private pending = false;
  private generation = 0;
  private frame = 0;
  private pointerActive = false;
  private timer = 0;
  private navigationTimer = 0;
  private url = location.href;
  private documentObserver?: MutationObserver;
  private observedCards: HTMLElement[] = [];
  private stateVersion = 0;
  status: PageStatus = { state: 'off', cards: 0, edges: 0, failed: 0, errors: [], truncated: false };
  private readonly events = new AbortController();
  start(): void {
    this.watchDocument();
    const options = { capture: true, passive: true, signal: this.events.signal };
    window.addEventListener('scroll', this.schedule, options);
    window.addEventListener('resize', this.schedule, options);
    document.addEventListener('pointerdown', () => { this.pointerActive = true; }, options);
    document.addEventListener('pointerup', this.endPointer, options);
    document.addEventListener('pointercancel', this.endPointer, options);
    document.addEventListener('pointermove', () => { if (this.pointerActive) this.schedule(); }, options);
    document.addEventListener('dragover', this.schedule, options);
    window.addEventListener('popstate', this.navigation, options);
    window.addEventListener('focus', this.refreshSettings, { ...options, capture: false });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refreshSettings(); }, options);
    document.addEventListener('turbo:load', this.navigation, options);
    window.addEventListener('pagehide', () => this.destroy(), { once: true, signal: this.events.signal });
    this.navigationTimer = window.setInterval(this.navigation, 1000);
    void this.refreshSettings();
  }
  private endPointer = (): void => { this.pointerActive = false; this.schedule(); };
  private watchDocument(): void {
    this.documentObserver?.disconnect();
    this.documentObserver = new MutationObserver(records => {
      this.navigation();
      if (!isExternalMutation(records) || this.timer) return;
      this.timer = window.setTimeout(() => { this.timer = 0; this.schedule(); }, 60);
    });
    this.documentObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['id', 'hidden', 'aria-hidden', 'data-view-type', 'data-testid', 'class', 'style', 'href', 'role', 'data-dnd-drop-id', 'data-dnd-drop-type', 'data-board-card-id', 'aria-disabled'] });
  }
  private navigation = (): void => {
    if (this.url === location.href) return;
    this.url = location.href;
    this.releaseBoard(); this.results.clear(); this.watchDocument();
    void this.refreshSettings();
  };
  private refreshSettings = async (): Promise<void> => {
    const version = ++this.stateVersion;
    if (!isProjectUrl(location.href)) { this.configure({ ...this.settings, enabled: false, authenticated: false }); return; }
    const reply = await send<Settings>({ type: 'GET_STATE' });
    if (version !== this.stateVersion) return;
    if (reply.ok) this.configure(reply.data);
    else { this.configure({ ...this.settings, enabled: false, authenticated: false }); this.status = { ...this.status, state: 'error', errors: [reply.error] }; }
  };
  configure(settings: Settings, relationshipsOnly = false): void {
    const preserveDependencies = relationshipsOnly && this.settings.enabled === settings.enabled && this.settings.authenticated === settings.authenticated;
    this.stateVersion++;
    this.settings = settings;
    this.relationships.destroy();
    if (preserveDependencies) { this.schedule(); return; }
    this.generation++; this.pending = false; this.results.clear();
    if (!settings.enabled || !settings.authenticated) { this.releaseBoard(); this.status = { state: 'off', cards: 0, edges: 0, failed: 0, errors: settings.authenticated ? [] : [{ code: 'AUTH_MISSING' }], truncated: false }; }
    this.schedule();
  }
  refreshRelationships(): void {
    this.generation++; this.pending = false; this.results.clear(); this.schedule();
  }
  private releaseBoard(): void {
    this.generation++; this.pending = false; this.observer?.disconnect(); this.observer = undefined;
    this.view = null; this.observedCards = []; this.renderer.destroy(); this.relationships.destroy();
  }
  schedule = (): void => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); }); };
  private update(): void {
    if (!this.settings.enabled || !this.settings.authenticated) return;
    const view = detectProjectView(document, location.href);
    if (view?.element !== this.view?.element || view?.kind !== this.view?.kind) {
      this.releaseBoard(); this.view = view;
      if (view) this.observer = new BoardObserver(view.element, this.schedule);
    }
    if (!view) { this.status = { state: 'no-view', cards: 0, edges: 0, failed: 0, errors: [], truncated: false }; return; }
    const candidates = extractCards(view.element, view.kind);
    const allCards = this.settings.relationshipsVisible && this.relationships.update(candidates) ? extractCards(view.element, view.kind) : candidates;
    const unique = [...new Map(allCards.map(c => [issueKey(c.issue), c.issue])).values()];
    const included = new Set(unique.slice(0, MAX_ISSUES).map(issueKey));
    const cards = allCards.filter(c => included.has(issueKey(c.issue)));
    if (cards.length !== this.observedCards.length || cards.some((c, n) => c.element !== this.observedCards[n])) {
      this.observedCards = cards.map(c => c.element); this.observer!.cards(this.observedCards, view.element);
    }
    const results = unique.slice(0, MAX_ISSUES).flatMap(i => { const result = this.results.get(issueKey(i)); return result ? [result] : []; });
    const dependencies: Dependency[] = results.flatMap(r => r.ok ? r.dependencies : []);
    const errors = results.flatMap(r => r.ok ? [] : [r.error]);
    const missing = unique.slice(0, MAX_ISSUES).filter(i => !this.results.has(issueKey(i)));
    const truncated = unique.length > MAX_ISSUES;
    const edges = this.renderer.render(cards, dependencies, projectViewRect(view.element, view.kind), { layout: view.kind, loading: missing.length > 0, incomplete: errors.length > 0 || truncated });
    const analysis = this.renderer.analysis!;
    this.status = {
      state: !cards.length ? 'no-cards' : missing.length ? 'loading' : errors.length ? (errors.length === results.length ? 'error' : 'partial') : 'ready',
      cards: cards.length, edges, failed: errors.length, errors, truncated, view: view.kind,
      analysis: { maxDepth: analysis.maxDepth, branches: analysis.branchCount, merges: analysis.mergeCount, cycleNodes: analysis.cycleNodeKeys.size }
    };
    if (!missing.length || this.pending) return;
    this.pending = true;
    const generation = this.generation;
    void send<IssueResult[]>({ type: 'DEPENDENCIES', issues: missing }).then(reply => {
      if (generation !== this.generation) return;
      for (const issue of missing) {
        const result = reply.ok ? reply.data.find(r => issueKey(r.issue) === issueKey(issue)) : undefined;
        this.results.set(issueKey(issue), result ?? { issue, ok: false, error: reply.ok ? { code: 'SCHEMA' } : reply.error });
      }
      this.pending = false; this.schedule();
    });
  }
  destroy(): void {
    this.stateVersion++; this.releaseBoard(); this.results.clear(); this.events.abort(); this.documentObserver?.disconnect();
    clearInterval(this.navigationTimer); clearTimeout(this.timer); cancelAnimationFrame(this.frame); this.frame = 0;
  }
}
