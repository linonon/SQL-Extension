import { useCallback, useEffect, useState } from 'react';
import { useVSCodeMessage } from '../../hooks/useVSCodeMessage';
import { usePostMessage } from '../../hooks/usePostMessage';
import type { ExtensionMessage } from '../../types/messages';
import type { DetailedColumnInfo, AlterTableChanges, AddColumnDef, ModifyColumnDef } from '../../types/database';
import './edit-table.css';

interface EditableColumn {
  readonly originalName: string;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue: string;
  readonly comment: string;
  readonly isPrimaryKey: boolean;
  readonly isNew: boolean;
  readonly isDropped: boolean;
  readonly isModified: boolean;
}

function toEditable(col: DetailedColumnInfo): EditableColumn {
  return {
    originalName: col.name,
    name: col.name,
    dataType: col.dataType,
    nullable: col.nullable,
    defaultValue: col.defaultValue ?? '',
    comment: col.comment,
    isPrimaryKey: col.isPrimaryKey,
    isNew: false,
    isDropped: false,
    isModified: false,
  };
}

function buildChanges(
  original: readonly DetailedColumnInfo[],
  columns: readonly EditableColumn[]
): AlterTableChanges {
  const addedColumns: AddColumnDef[] = [];
  const droppedColumns: string[] = [];
  const modifiedColumns: ModifyColumnDef[] = [];
  const renamedColumns: { from: string; to: string }[] = [];

  for (const col of columns) {
    if (col.isNew && !col.isDropped) {
      addedColumns.push({
        name: col.name,
        dataType: col.dataType,
        nullable: col.nullable,
        defaultValue: col.defaultValue || null,
        comment: col.comment,
      });
      continue;
    }

    if (col.isDropped && !col.isNew) {
      droppedColumns.push(col.originalName);
      continue;
    }

    if (col.isNew || col.isDropped) { continue; }

    // 检查是否 rename
    if (col.name !== col.originalName) {
      renamedColumns.push({ from: col.originalName, to: col.name });
    }

    // 检查是否 modify
    const orig = original.find((o) => o.name === col.originalName);
    if (!orig) { continue; }

    const mods: ModifyColumnDef = {
      name: col.name !== col.originalName ? col.name : col.originalName,
      ...(col.dataType !== orig.dataType ? { dataType: col.dataType } : {}),
      ...(col.nullable !== orig.nullable ? { nullable: col.nullable } : {}),
      ...(col.defaultValue !== (orig.defaultValue ?? '') ? { defaultValue: col.defaultValue || null } : {}),
      ...(col.comment !== orig.comment ? { comment: col.comment } : {}),
    };

    const hasChanges = mods.dataType !== undefined || mods.nullable !== undefined
      || mods.defaultValue !== undefined || mods.comment !== undefined;

    if (hasChanges) {
      modifiedColumns.push(mods);
    }
  }

  return { addedColumns, droppedColumns, modifiedColumns, renamedColumns };
}

interface EditTableProps {
  readonly database: string;
  readonly table: string;
}

export function EditTable({ database, table }: EditTableProps) {
  const postMessage = usePostMessage();
  const [originalColumns, setOriginalColumns] = useState<DetailedColumnInfo[]>([]);
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [ddlPreview, setDdlPreview] = useState<string>('');
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');

  const handleMessage = useCallback((message: ExtensionMessage) => {
    switch (message.type) {
      case 'tableDetails': {
        setOriginalColumns(message.columns);
        setColumns(message.columns.map(toEditable));
        setSelectedIndex(-1);
        break;
      }
      case 'alterTableResult': {
        if (message.ddlPreview) {
          setDdlPreview(message.ddlPreview);
          setShowPreview(true);
        } else if (message.success) {
          setSuccessMsg('Changes applied successfully');
          setError('');
          setShowPreview(false);
          setDdlPreview('');
          setTimeout(() => setSuccessMsg(''), 3000);
        } else {
          setError(message.error ?? 'Unknown error');
          setSuccessMsg('');
        }
        break;
      }
    }
  }, []);

  useVSCodeMessage(handleMessage);

  useEffect(() => {
    postMessage({ type: 'fetchTableDetails', database, table });
  }, [postMessage, database, table]);

  const updateColumn = useCallback((index: number, field: keyof EditableColumn, value: string | boolean) => {
    setColumns((prev) =>
      prev.map((col, i) => {
        if (i !== index) { return col; }
        return { ...col, [field]: value, isModified: true };
      })
    );
  }, []);

  const addColumn = useCallback(() => {
    const newCol: EditableColumn = {
      originalName: '',
      name: '',
      dataType: 'varchar(255)',
      nullable: true,
      defaultValue: '',
      comment: '',
      isPrimaryKey: false,
      isNew: true,
      isDropped: false,
      isModified: false,
    };
    setColumns((prev) => [...prev, newCol]);
    setSelectedIndex(columns.length);
  }, [columns.length]);

  const dropColumn = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= columns.length) { return; }
    const col = columns[selectedIndex];
    if (col.isNew) {
      // 新增的列直接删除
      setColumns((prev) => prev.filter((_, i) => i !== selectedIndex));
      setSelectedIndex(-1);
    } else {
      // 已有列标记为 dropped
      setColumns((prev) =>
        prev.map((c, i) => i === selectedIndex ? { ...c, isDropped: !c.isDropped } : c)
      );
    }
  }, [selectedIndex, columns]);

  const previewDDL = useCallback(() => {
    const changes = buildChanges(originalColumns, columns);
    postMessage({ type: 'previewAlterTable', database, table, changes });
  }, [postMessage, database, table, originalColumns, columns]);

  const applyChanges = useCallback(() => {
    const changes = buildChanges(originalColumns, columns);
    const hasChanges = changes.addedColumns.length > 0
      || changes.droppedColumns.length > 0
      || changes.modifiedColumns.length > 0
      || changes.renamedColumns.length > 0;

    if (!hasChanges) {
      setError('No changes to apply');
      return;
    }
    setError('');
    setSuccessMsg('');
    postMessage({ type: 'alterTable', database, table, changes });
  }, [postMessage, database, table, originalColumns, columns]);

  return (
    <div className="edit-table">
      <div className="edit-table-header">
        <h2>Edit Table: {table}</h2>
        <div className="edit-table-toolbar">
          <button onClick={addColumn}>Add Column</button>
          <button onClick={dropColumn} disabled={selectedIndex < 0}>
            {selectedIndex >= 0 && columns[selectedIndex]?.isDropped ? 'Restore Column' : 'Drop Column'}
          </button>
          <button onClick={previewDDL}>Preview DDL</button>
          <button className="primary" onClick={applyChanges}>Apply Changes</button>
        </div>
      </div>

      {error && <div className="edit-table-error">{error}</div>}
      {successMsg && <div className="edit-table-success">{successMsg}</div>}

      <div className="edit-table-grid">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Not NULL</th>
              <th>Default</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, index) => (
              <tr
                key={col.isNew ? `new-${index}` : col.originalName}
                className={[
                  selectedIndex === index ? 'selected' : '',
                  col.isDropped ? 'dropped' : '',
                  col.isNew ? 'new-col' : '',
                  col.isModified && !col.isNew ? 'modified' : '',
                ].join(' ')}
                onClick={() => setSelectedIndex(index)}
              >
                <td>
                  <input
                    type="text"
                    value={col.name}
                    onChange={(e) => updateColumn(index, 'name', e.target.value)}
                    disabled={col.isDropped}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={col.dataType}
                    onChange={(e) => updateColumn(index, 'dataType', e.target.value)}
                    disabled={col.isDropped}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!col.nullable}
                    onChange={(e) => updateColumn(index, 'nullable', !e.target.checked)}
                    disabled={col.isDropped}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={col.defaultValue}
                    onChange={(e) => updateColumn(index, 'defaultValue', e.target.value)}
                    disabled={col.isDropped}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={col.comment}
                    onChange={(e) => updateColumn(index, 'comment', e.target.value)}
                    disabled={col.isDropped}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showPreview && (
        <div className="edit-table-preview">
          <div className="preview-header">
            <h3>DDL Preview</h3>
            <button onClick={() => setShowPreview(false)}>Close</button>
          </div>
          <pre>{ddlPreview}</pre>
        </div>
      )}
    </div>
  );
}
