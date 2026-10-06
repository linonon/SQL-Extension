import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EditTable, buildChanges, toEditable } from './EditTable';
import type { DetailedColumnInfo } from '../../../../src/types/query';

describe('EditTable', () => {
  it('Preview DDL 没有改动时显示 No changes, 不报 applied', () => {
    render(<EditTable database="db" table="t" />);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'alterTablePreview', ddl: '' } })); });
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.queryByText(/applied successfully/)).not.toBeInTheDocument();
  });

  it('改动的列发完整定义: 未改的属性取原列 (默认值区分 null 与空串), 带原列 extra', () => {
    const original: DetailedColumnInfo[] = [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, defaultValue: null, extra: 'auto_increment', comment: '主键' },
      { name: 'code', dataType: 'varchar(8)', nullable: false, isPrimaryKey: false, defaultValue: '', extra: '', comment: '' },
    ];
    const columns = original.map(toEditable);
    const edited = [{ ...columns[0], dataType: 'bigint' }, { ...columns[1], comment: '编码' }];
    expect(buildChanges(original, edited).modifiedColumns).toEqual([
      { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, comment: '主键', extra: 'auto_increment', changed: ['dataType'] },
      { name: 'code', dataType: 'varchar(8)', nullable: false, defaultValue: '', comment: '编码', extra: '', changed: ['comment'] },
    ]);
  });
});
