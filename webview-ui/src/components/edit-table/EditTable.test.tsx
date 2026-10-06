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

  it('改名的列属性没改也发完整定义 (MySQL 写 CHANGE COLUMN), 带原列的 collation 与生成列表达式', () => {
    const original: DetailedColumnInfo[] = [
      { name: 'nick', dataType: 'varchar(32)', nullable: true, isPrimaryKey: false, defaultValue: 'x', extra: '', comment: 'n', collation: 'utf8mb4_bin' },
      { name: 'gen', dataType: 'int', nullable: true, isPrimaryKey: false, defaultValue: null, extra: 'VIRTUAL GENERATED', comment: '', generationExpression: '(`a` * 2)' },
    ];
    const columns = original.map(toEditable);
    const changes = buildChanges(original, [{ ...columns[0], name: 'nickname' }, { ...columns[1], comment: 'g' }]);
    expect(changes.renamedColumns).toEqual([{ from: 'nick', to: 'nickname' }]);
    expect(changes.modifiedColumns).toEqual([
      { name: 'nickname', dataType: 'varchar(32)', nullable: true, defaultValue: 'x', comment: 'n', extra: '', collation: 'utf8mb4_bin', changed: [] },
      { name: 'gen', dataType: 'int', nullable: true, defaultValue: null, comment: 'g', extra: 'VIRTUAL GENERATED', generationExpression: '(`a` * 2)', changed: ['comment'] },
    ]);
  });
});
