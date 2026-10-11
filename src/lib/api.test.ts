import { getDb } from '../db/db'
import * as schema from '../db/schema'
import { getGroupExpenses } from './api'

jest.mock('../db/db', () => ({
  getDb: jest.fn(),
}))

let mockIdCount = 0
jest.mock('nanoid', () => ({
  nanoid: () => `random-id-${++mockIdCount}`,
}))

const insertCalls: { table: unknown; values: unknown }[] = []
const mockDb = {
  batch: jest.fn(async () => []),
  insert: jest.fn((table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values })
      return { table, values }
    },
  })),
  update: jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => ({})),
    })),
  })),
  query: {
    expense: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    recurringExpenseLink: {
      findMany: jest.fn(),
    },
  },
}

describe('getGroupExpenses', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    insertCalls.length = 0
    jest.mocked(getDb).mockReturnValue(mockDb as never)
  })

  it('copies recurring expense documents rather than moving them', async () => {
    const document = {
      id: 'document-1',
      url: 'https://example.com/receipt.jpg',
      width: 800,
      height: 600,
      expenseId: 'expense-1',
    }
    const currentFrameExpense = {
      id: 'expense-1',
      groupId: 'group-1',
      title: 'Rent',
      amount: 1000,
      categoryId: 0,
      paidById: 'participant-1',
      recurrenceRule: 'DAILY',
      createdAt: new Date(),
      category: null,
      paidBy: { id: 'participant-1' },
      paidFor: [
        { expenseId: 'expense-1', participantId: 'participant-1', shares: 1 },
      ],
      documents: [document],
    }

    mockDb.query.recurringExpenseLink.findMany.mockResolvedValue([
      {
        id: 'link-1',
        groupId: 'group-1',
        currentFrameExpenseId: 'expense-1',
        // An hour ago, so exactly one daily occurrence is due.
        nextExpenseDate: new Date(Date.now() - 60 * 60 * 1000),
        nextExpenseCreatedAt: null,
        currentFrameExpense,
      },
    ] as never)
    mockDb.query.expense.findFirst.mockResolvedValue(undefined)
    mockDb.query.expense.findMany.mockResolvedValue([])

    await getGroupExpenses('group-1')

    const documentInsert = insertCalls.find(
      ({ table }) => table === schema.expenseDocument,
    )
    expect(documentInsert?.values).toEqual([
      {
        id: expect.any(String),
        expenseId: expect.any(String),
        url: document.url,
        width: document.width,
        height: document.height,
      },
    ])
    // Reusing the id would point the existing document at the new expense.
    expect(documentInsert?.values).not.toContainEqual(
      expect.objectContaining({ id: document.id }),
    )
    expect(mockDb.update).not.toHaveBeenCalledWith(schema.expenseDocument)
    expect(mockDb.batch).toHaveBeenCalledTimes(1)
  })
})
