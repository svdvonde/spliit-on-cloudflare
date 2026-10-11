import { getDb } from '@/db/db'
import * as schema from '@/db/schema'
import { env } from '@/lib/env'
import { getUploadKeyFromUrl } from '@/lib/uploaded-image-url'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { and, eq, inArray, lte, notExists } from 'drizzle-orm'

export type PurgeResult = {
  purgedGroupIds: string[]
  failedGroupIds: string[]
}

const S3_DELETE_CONCURRENCY = 10

let s3Client: S3Client | undefined

// Configured the same way next-s3-upload configures the client it uploads with
// (see src/app/api/s3-upload/route.ts).
function getS3Client() {
  s3Client ??= new S3Client({
    credentials: {
      accessKeyId: env.S3_UPLOAD_KEY ?? '',
      secretAccessKey: env.S3_UPLOAD_SECRET ?? '',
    },
    region: env.S3_UPLOAD_REGION,
    endpoint: env.S3_UPLOAD_ENDPOINT,
    forcePathStyle: !!env.S3_UPLOAD_ENDPOINT,
  })
  return s3Client
}

/**
 * Permanently deletes every group whose deletion grace period has ended, with
 * all its data and uploaded documents. A group that fails is left in place, so
 * the next run retries it.
 */
export async function purgeScheduledGroups(
  now = new Date(),
): Promise<PurgeResult> {
  const db = getDb()
  const groups = await db
    .select({ id: schema.group.id })
    .from(schema.group)
    .where(lte(schema.group.deleteAt, now))

  const result: PurgeResult = { purgedGroupIds: [], failedGroupIds: [] }
  for (const { id } of groups) {
    try {
      await purgeGroup(id, now)
      result.purgedGroupIds.push(id)
    } catch (error) {
      console.error(`Failed to purge group ${id}`, error)
      result.failedGroupIds.push(id)
    }
  }
  return result
}

async function purgeGroup(groupId: string, now: Date) {
  const db = getDb()
  const documents = await db
    .select({
      id: schema.expenseDocument.id,
      url: schema.expenseDocument.url,
    })
    .from(schema.expenseDocument)
    .innerJoin(
      schema.expense,
      eq(schema.expenseDocument.expenseId, schema.expense.id),
    )
    .where(eq(schema.expense.groupId, groupId))

  // Files go first: once the rows are gone, nothing points to them anymore.
  // URLs outside the configured bucket are not ours to delete. The group can
  // no longer be restored at this point (see restoreGroup), so this is final.
  // One DeleteObject per file rather than a DeleteObjects batch, which some
  // S3-compatible providers reject, but several at a time.
  const keys = documents
    .map(({ url }) => getUploadKeyFromUrl(url))
    .filter((key) => key !== null)
  for (let i = 0; i < keys.length; i += S3_DELETE_CONCURRENCY) {
    await Promise.all(
      keys
        .slice(i, i + S3_DELETE_CONCURRENCY)
        .map((key) =>
          getS3Client().send(
            new DeleteObjectCommand({ Bucket: env.S3_UPLOAD_BUCKET, Key: key }),
          ),
        ),
    )
  }

  // Deleting the group cascades to its participants, expenses and activities,
  // but documents are only detached from their expense, so they go explicitly.
  // Keep both deletions atomic, and only delete documents if the group was
  // actually removed (it may have been restored since the initial query).
  const deletedGroups = await db.batch([
    db
      .delete(schema.group)
      .where(and(eq(schema.group.id, groupId), lte(schema.group.deleteAt, now)))
      .returning({ id: schema.group.id }),
    ...(documents.length > 0
      ? [
          db.delete(schema.expenseDocument).where(
            and(
              inArray(
                schema.expenseDocument.id,
                documents.map((document) => document.id),
              ),
              notExists(
                db
                  .select({ id: schema.group.id })
                  .from(schema.group)
                  .where(eq(schema.group.id, groupId)),
              ),
            ),
          ),
        ]
      : []),
  ])
  if (deletedGroups[0].length === 0) {
    throw new Error(`Group ${groupId} is no longer scheduled for deletion`)
  }
}
