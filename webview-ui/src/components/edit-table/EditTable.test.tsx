import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EditTable } from './EditTable';

describe('EditTable', () => {
  it('Preview DDL 没有改动时显示 No changes, 不报 applied', () => {
    render(<EditTable database="db" table="t" />);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'alterTablePreview', ddl: '' } })); });
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.queryByText(/applied successfully/)).not.toBeInTheDocument();
  });
});
