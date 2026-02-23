import { AutocompletePopup } from '../sql-editor/AutocompletePopup';
import { useMongoAutocomplete } from '../../hooks/useMongoAutocomplete';

interface MongoFilterInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onApply: () => void;
  readonly fieldNames: readonly string[];
  readonly placeholder?: string;
}

export function MongoFilterInput({
  value,
  onChange,
  onApply,
  fieldNames,
  placeholder,
}: MongoFilterInputProps) {
  const {
    textareaRef, completionItems, selectedIndex, popupPos,
    handleChange, handleKeyDown, applyCompletion,
  } = useMongoAutocomplete({ fieldNames, value, onChange, onApply });

  return (
    <div className="mongo-filter-input-wrapper">
      <textarea
        ref={textareaRef}
        className="mongo-filter-input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
      />
      <AutocompletePopup
        items={completionItems}
        selectedIndex={selectedIndex}
        top={popupPos.top}
        left={popupPos.left}
        onSelect={applyCompletion}
      />
    </div>
  );
}
