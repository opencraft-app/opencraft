export function socketRequest(socketPath: string,path: string,body?: unknown,method?: string): Promise<any>;
export function nodeObserver(component: string,options?: {socketPath?: string; sourceRevision?: string | null;buildId?: string | null;processResources?: boolean}): {emit(fields: Record<string,unknown>): boolean;close(): void;execution(engine: string,method: string,params: unknown): void;queue(engine: string,threadId: string,count: number): void;stats?(): unknown};
export function observationGrafanaBasePath(value?: string): string;
