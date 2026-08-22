import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { relations } from './relations';

type D1Binding = Parameters<typeof drizzle>[0]



export const getDb = () => {
  const processEnvDb = (process.env as { DB?: unknown }).DB as D1Binding | undefined
  if (processEnvDb?.prepare) {
    return drizzle(processEnvDb, { relations })
  }

  const contextDb = (getCloudflareContext().env as { DB?: unknown }).DB as D1Binding | undefined
  if (contextDb?.prepare) {
    return drizzle(contextDb, { relations })
  }

  throw new Error('Cloudflare D1 binding "DB" is not available in the current runtime context')
}