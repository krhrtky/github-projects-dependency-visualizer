import { issueKey, type IssueIdentity } from '../domain/issue';
import type { Dependency } from '../domain/graph';
import { CACHE_TTL } from '../shared/config';
import type { GitHubApi } from './github-api';
export class DependencyRepository {
  private readonly cache = new Map<string, { expires: number; dependencies: Dependency[] }>();
  private readonly pending = new Map<string, Promise<Dependency[]>>();
  private generation = 0;
  constructor(private readonly api: Pick<GitHubApi, 'blockedBy'>, private readonly now = Date.now) {}
  clear(): void { this.generation++; this.cache.clear(); this.pending.clear(); }
  get(issue: IssueIdentity): Promise<Dependency[]> {
    const key = issueKey(issue);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.dependencies);
    const running = this.pending.get(key);
    if (running) return running;
    const generation = this.generation;
    const promise = this.api.blockedBy(issue).then(dependencies => {
      if (generation === this.generation) {
        this.cache.delete(key);
        this.cache.set(key, { expires: this.now() + CACHE_TTL, dependencies });
        if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
      }
      return dependencies;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
}
