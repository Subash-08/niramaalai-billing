'use client';

import React, { useState, useEffect, useRef, useId, useCallback } from 'react';
import { Search, X, ChevronDown, Check, Loader2 } from 'lucide-react';

export interface SearchOption {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  data?: any;
}

export interface SearchSelectProps {
  id?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  selectedLabel?: string;
  options?: SearchOption[];
  onSearch?: (query: string, signal: AbortSignal) => Promise<SearchOption[]>;
  onChange: (value: string, item?: SearchOption) => void;
  onClear?: () => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export default function SearchSelect({
  id: explicitId,
  label,
  placeholder = 'Type to search...',
  value = '',
  selectedLabel,
  options = [],
  onSearch,
  onChange,
  onClear,
  disabled = false,
  required = false,
  className = '',
  autoFocus = false,
}: SearchSelectProps) {
  const generatedId = useId();
  const inputId = explicitId || generatedId;
  const listboxId = `${inputId}-listbox`;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [asyncResults, setAsyncResults] = useState<SearchOption[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Compute displayed label for current value
  const selectedOption = options.find((opt) => opt.value === value) ||
    asyncResults.find((opt) => opt.value === value);
  const displayLabel = selectedLabel || selectedOption?.label || '';

  // Filter static options if no async search
  const visibleOptions = onSearch
    ? asyncResults
    : query.trim()
    ? options.filter((opt) =>
        `${opt.label} ${opt.sublabel || ''} ${opt.badge || ''}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : options;

  // Debounced async search with cancellation
  useEffect(() => {
    if (!onSearch) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await onSearch(query, controller.signal);
        if (!controller.signal.aborted) {
          setAsyncResults(results);
          setActiveIndex(-1);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('Search error:', err);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 280);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, onSearch]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Scroll active item into view
  useEffect(() => {
    if (isOpen && activeIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[activeIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex, isOpen]);

  const handleSelect = useCallback(
    (opt: SearchOption) => {
      onChange(opt.value, opt);
      setIsOpen(false);
      setQuery('');
      setActiveIndex(-1);
    },
    [onChange]
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange('', undefined);
      if (onClear) onClear();
      setQuery('');
      setActiveIndex(-1);
      inputRef.current?.focus();
    },
    [onChange, onClear]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        e.preventDefault();
        setIsOpen(true);
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setQuery('');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < visibleOptions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : visibleOptions.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < visibleOptions.length) {
        handleSelect(visibleOptions[activeIndex]);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={`search-select-container ${className} ${disabled ? 'disabled' : ''}`}
      style={{ position: 'relative', width: '100%' }}
    >
      {label && (
        <label
          htmlFor={inputId}
          className="search-select-label"
          style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}
        >
          {label} {required && <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>}
        </label>
      )}

      <div
        className={`search-select-control ${isOpen ? 'focused' : ''} ${value ? 'has-value' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          border: '1px solid var(--border, #d1d5db)',
          borderRadius: '6px',
          background: 'var(--surface, #ffffff)',
          padding: '0.45rem 0.65rem',
          cursor: disabled ? 'not-allowed' : 'pointer',
          minHeight: '38px',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          boxShadow: isOpen ? '0 0 0 2px rgba(99, 102, 241, 0.2)' : 'none',
          borderColor: isOpen ? 'var(--primary, #6366f1)' : 'var(--border, #d1d5db)',
        }}
        onClick={() => {
          if (!disabled) {
            setIsOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        <Search size={15} style={{ color: 'var(--text-muted, #9ca3af)', marginRight: '0.5rem', flexShrink: 0 }} />

        {value && !isOpen ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
            <span
              style={{
                fontSize: '0.9rem',
                fontWeight: 500,
                color: 'var(--text, #111827)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {displayLabel || value}
            </span>
            {selectedOption?.badge && (
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  background: 'var(--primary-light, #e0e7ff)',
                  color: 'var(--primary-dark, #3730a3)',
                  marginLeft: '0.5rem',
                  fontWeight: 600,
                }}
              >
                {selectedOption.badge}
              </span>
            )}
          </div>
        ) : (
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            autoComplete="off"
            autoFocus={autoFocus}
            disabled={disabled}
            value={query}
            placeholder={value ? displayLabel || placeholder : placeholder}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onKeyDown={handleKeyDown}
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: '0.9rem',
              width: '100%',
              flex: 1,
              color: 'var(--text, #111827)',
            }}
          />
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '0.5rem' }}>
          {loading && <Loader2 size={15} className="spinner" style={{ color: 'var(--primary, #6366f1)', animation: 'spin 1s linear infinite' }} />}

          {value && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              onClick={handleClear}
              aria-label="Clear selection"
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                padding: '2px',
                color: 'var(--text-muted, #9ca3af)',
                display: 'flex',
                alignItems: 'center',
                borderRadius: '50%',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text, #111827)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted, #9ca3af)')}
            >
              <X size={14} />
            </button>
          )}

          <ChevronDown
            size={15}
            style={{
              color: 'var(--text-muted, #9ca3af)',
              transform: isOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          />
        </div>
      </div>

      {isOpen && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 999,
            maxHeight: '260px',
            overflowY: 'auto',
            background: 'var(--surface, #ffffff)',
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: '6px',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
            listStyle: 'none',
            margin: 0,
            padding: '4px 0',
          }}
        >
          {loading && visibleOptions.length === 0 ? (
            <li style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--text-muted, #6b7280)', textAlign: 'center' }}>
              Searching...
            </li>
          ) : visibleOptions.length === 0 ? (
            <li style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--text-muted, #6b7280)', textAlign: 'center' }}>
              No matches found
            </li>
          ) : (
            visibleOptions.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isActive = idx === activeIndex;

              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  style={{
                    padding: '0.55rem 0.75rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.88rem',
                    background: isActive
                      ? 'var(--surface-hover, #f3f4f6)'
                      : isSelected
                      ? 'var(--surface-selected, #eef2ff)'
                      : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--primary, #6366f1)' : '3px solid transparent',
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelect(opt)}
                >
                  <div style={{ flex: 1, minWidth: 0, marginRight: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: isSelected ? 600 : 500, color: 'var(--text, #111827)' }}>
                        {opt.label}
                      </span>
                      {opt.badge && (
                        <span
                          style={{
                            fontSize: '0.7rem',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            background: 'var(--badge-bg, #e5e7eb)',
                            color: 'var(--badge-text, #374151)',
                            fontWeight: 600,
                          }}
                        >
                          {opt.badge}
                        </span>
                      )}
                    </div>
                    {opt.sublabel && (
                      <div
                        style={{
                          fontSize: '0.78rem',
                          color: 'var(--text-muted, #6b7280)',
                          marginTop: '2px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {opt.sublabel}
                      </div>
                    )}
                  </div>
                  {isSelected && <Check size={16} style={{ color: 'var(--primary, #6366f1)', flexShrink: 0 }} />}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
