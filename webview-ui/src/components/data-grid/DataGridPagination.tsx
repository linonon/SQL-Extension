import type { PageInfo } from '../../types/database';

interface DataGridPaginationProps {
  readonly page: PageInfo;
  readonly onPageChange: (offset: number) => void;
}

export function DataGridPagination({ page, onPageChange }: DataGridPaginationProps) {
  const currentPage = Math.floor(page.offset / page.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  const from = page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);

  return (
    <div className="data-grid-pagination">
      <span className="page-info">
        {page.total > 0
          ? `Rows ${from}-${to} of ${page.total}`
          : 'No rows'}
      </span>
      <div className="page-controls">
        <button
          disabled={currentPage <= 1}
          onClick={() => onPageChange(0)}
        >
          First
        </button>
        <button
          disabled={currentPage <= 1}
          onClick={() => onPageChange(page.offset - page.limit)}
        >
          Prev
        </button>
        <span>
          Page {currentPage} / {totalPages}
        </span>
        <button
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(page.offset + page.limit)}
        >
          Next
        </button>
        <button
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange((totalPages - 1) * page.limit)}
        >
          Last
        </button>
      </div>
    </div>
  );
}
