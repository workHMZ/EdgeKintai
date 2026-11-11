/**
 * Authentication must fail closed when the production rate-limit binding is
 * unavailable. Local preview remains usable because Wrangler may omit or stub
 * the binding during development.
 */
export async function checkRateLimit(
  limiter: RateLimit | undefined,
  key: string,
  request: Request,
): Promise<boolean> {
  const localPreview = isLocalPreviewRequest(request);

  if (!limiter || typeof limiter.limit !== 'function') {
    if (!localPreview) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'rate_limiter_unavailable',
        message: 'authentication rate limiter binding is unavailable',
      }));
    }
    return localPreview;
  }

  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'rate_limiter_failed',
      message: 'authentication rate limiter failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    return localPreview;
  }
}

function isLocalPreviewRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
