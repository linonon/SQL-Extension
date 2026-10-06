import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MongoExplainPanel } from './MongoExplainPanel';

describe('MongoExplainPanel', () => {
  it('COLLSCAN -> 显示全表扫描警告', () => {
    render(
      <MongoExplainPanel
        summary={{ stage: 'COLLSCAN', isCollScan: true }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/COLLSCAN/)).toBeInTheDocument();
    expect(screen.getByText(/全表扫描|无索引|建议/)).toBeInTheDocument();
  });

  it('IXSCAN -> 显示索引名, 无警告', () => {
    render(
      <MongoExplainPanel
        summary={{ stage: 'IXSCAN', indexName: 'age_1', isCollScan: false }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/age_1/)).toBeInTheDocument();
    expect(screen.queryByText(/全表扫描/)).toBeNull();
  });

  it('error -> 显示错误', () => {
    render(<MongoExplainPanel error="explain failed" onClose={vi.fn()} />);
    expect(screen.getByText(/explain failed/)).toBeInTheDocument();
  });

  it('loading -> 显示加载中', () => {
    render(<MongoExplainPanel loading onClose={vi.fn()} />);
    expect(screen.getByText(/running explain/i)).toBeInTheDocument();
  });
});
