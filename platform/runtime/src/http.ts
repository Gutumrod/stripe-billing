import { CentralBillingRuntime } from './runtime';

export interface NodeIncomingMessageLike {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<Uint8Array>;
}

export interface NodeServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: Uint8Array | string): void;
}

export interface BillingHttpHandlerOptions {
  defaultHost?: string;
}

export function createBillingHttpHandler(
  runtime: CentralBillingRuntime,
  options?: BillingHttpHandlerOptions,
): (req: NodeIncomingMessageLike, res: NodeServerResponseLike) => Promise<void> {
  const defaultHost = options?.defaultHost ?? '127.0.0.1';
  return async (req: NodeIncomingMessageLike, res: NodeServerResponseLike): Promise<void> => {
    try {
      const hostHeader = req.headers.host;
      const host = typeof hostHeader === 'string' ? hostHeader : defaultHost;
      const url = `http://${host}${req.url ?? '/'}`;
      const method = req.method ?? 'GET';
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }
      const init: RequestInit = { method, headers };
      const asyncIter = req[Symbol.asyncIterator];
      if (method !== 'GET' && method !== 'HEAD' && typeof asyncIter === 'function') {
        const iterator = asyncIter.call(req);
        init.body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await iterator.next();
            if (done) {
              controller.close();
            } else if (value) {
              controller.enqueue(value);
            }
          },
        });
        (init as Record<string, unknown>).duplex = 'half';
      }
      const response = await runtime.handle(new Request(url, init));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const bytes = new Uint8Array(await response.arrayBuffer());
      res.end(bytes);
    } catch {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'HTTP_ADAPTER_FAILED' }));
    }
  };
}
