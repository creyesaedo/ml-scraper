import { CategoriesService } from './categories.service';

function makeService() {
  const prisma = { category: { findMany: jest.fn().mockResolvedValue([]) } } as any;
  return { service: new CategoriesService(prisma), prisma };
}

describe('CategoriesService', () => {
  it('lists all categories ordered by id with no filters', async () => {
    const { service, prisma } = makeService();
    await service.findAll();
    expect(prisma.category.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { id: 'asc' } });
  });

  it('filters by country', async () => {
    const { service, prisma } = makeService();
    await service.findAll('MLC');
    expect(prisma.category.findMany.mock.calls[0][0].where).toEqual({ country: 'MLC' });
  });

  it('filters to root categories only', async () => {
    const { service, prisma } = makeService();
    await service.findAll(undefined, true);
    expect(prisma.category.findMany.mock.calls[0][0].where).toEqual({ parent_id: null });
  });

  it('combines country and parent-only filters', async () => {
    const { service, prisma } = makeService();
    await service.findAll('MLA', true);
    expect(prisma.category.findMany.mock.calls[0][0].where).toEqual({
      country: 'MLA',
      parent_id: null,
    });
  });
});
