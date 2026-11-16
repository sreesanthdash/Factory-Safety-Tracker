import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const menuMotion = {
  initial: { opacity: 0, y: -3 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -2 },
  transition: { type: "tween", duration: 0.14, ease: "easeOut" }
};

export default function Dropdown({
  id,
  name,
  label,
  className = "",
  options = [],
  value,
  defaultValue,
  onChange,
  triggerClassName = "",
  disabled = false,
  loading = false,
  error = "",
  success = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy
}) {
  const generatedId = useId().replaceAll(":", "");
  const controlId = id || `dropdown-${generatedId}`;
  const listId = `${controlId}-listbox`;
  const labelId = `${controlId}-label`;
  const errorId = `${controlId}-error`;
  const isControlled = value !== undefined;
  const [innerValue, setInnerValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const selectedValue = isControlled ? value : innerValue;
  const selectedIndex = Math.max(0, options.findIndex((option) => String(option.value) === String(selectedValue)));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const typeahead = useRef({ text: "", timer: null });
  const prefersReducedMotion = useReducedMotion();
  const initialValue = useRef(defaultValue ?? options[0]?.value ?? "");
  const normalizedOptions = useMemo(() => options.map((option) => ({
    value: String(option.value ?? option.label ?? option.name ?? ""),
    label: String(option.label ?? option.name ?? option.value ?? "")
  })), [options]);
  const selected = normalizedOptions.find((option) => option.value === String(selectedValue)) || normalizedOptions[0];
  const active = normalizedOptions[activeIndex];

  useEffect(() => {
    if (!isControlled && !options.some((option) => String(option.value ?? option.label ?? option.name ?? "") === String(innerValue)) && normalizedOptions[0]) {
      setInnerValue(normalizedOptions[0].value);
    }
  }, [innerValue, isControlled, normalizedOptions, options]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = 12;
      const maxHeight = Math.max(120, Math.min(300, window.innerHeight - edge * 2));
      const width = Math.min(Math.max(rect.width, 192), window.innerWidth - edge * 2);
      const left = Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge));
      const below = window.innerHeight - rect.bottom - edge;
      const top = below >= Math.min(210, maxHeight) ? rect.bottom + 7 : Math.max(edge, rect.top - maxHeight - 7);
      setMenuStyle({ top, left, width, maxHeight });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, normalizedOptions.length]);

  useEffect(() => {
    if (!open) return undefined;
    const dismissOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return undefined;
    const reset = () => {
      if (!isControlled) setInnerValue(String(initialValue.current));
      setOpen(false);
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [isControlled]);

  function choose(index) {
    const option = normalizedOptions[index];
    if (!option) return;
    if (!isControlled) setInnerValue(option.value);
    onChange?.({ target: { value: option.value } });
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(step) {
    if (!normalizedOptions.length) return;
    setActiveIndex((current) => (current + step + normalizedOptions.length) % normalizedOptions.length);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setActiveIndex(selectedIndex); setOpen(true); }
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!normalizedOptions.length) return;
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : normalizedOptions.length - 1);
      setOpen(true);
      return;
    }
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else { setActiveIndex(selectedIndex); setOpen(true); }
      return;
    }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && normalizedOptions.length) {
      const typed = event.key.toLocaleLowerCase();
      const prior = typeahead.current.text;
      const nextText = prior.length && [...prior].every((character) => character === typed) ? typed : prior + typed;
      typeahead.current.text = nextText;
      window.clearTimeout(typeahead.current.timer);
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = ""; }, 650);
      const start = open ? activeIndex + 1 : selectedIndex;
      const match = Array.from({ length: normalizedOptions.length }, (_, offset) => (start + offset) % normalizedOptions.length)
        .find((index) => normalizedOptions[index].label.toLocaleLowerCase().startsWith(nextText));
      if (match !== undefined) { setActiveIndex(match); setOpen(true); }
    }
  }

  const menu = <AnimatePresence initial={false}>
    {open && <motion.div
      {...menuMotion}
      ref={menuRef}
      className="glass-dropdown__menu"
      id={listId}
      role="listbox"
      aria-labelledby={label ? labelId : undefined}
      style={menuStyle || { visibility: "hidden" }}
    >
      {normalizedOptions.map((option, index) => <motion.button
        key={option.value}
        id={`${controlId}-option-${index}`}
        className="glass-dropdown__option"
        type="button"
        role="option"
        aria-selected={option.value === String(selected?.value)}
        data-active={index === activeIndex ? "true" : undefined}
        tabIndex={-1}
        whileHover={{ opacity: 0.96 }}
        whileTap={{ opacity: 0.92 }}
        transition={{ type: "tween", duration: 0.14, ease: "easeOut" }}
        onPointerMove={() => setActiveIndex(index)}
        onClick={() => choose(index)}
      >{option.label}{option.value === String(selected?.value) && <span aria-hidden="true">✓</span>}</motion.button>)}
      {!normalizedOptions.length && <span className="glass-dropdown__empty" role="option" aria-disabled="true">No options available</span>}
    </motion.div>}
  </AnimatePresence>;

  return <div className={`glass-dropdown${loading ? " is-loading" : ""}${error ? " has-error" : ""}${success ? " is-success" : ""} ${className}`.trim()} ref={rootRef}>
    {label && <label className="glass-dropdown__label" id={labelId} htmlFor={controlId}>{label}</label>}
    <motion.button
      ref={triggerRef}
      className={`control glass-dropdown__trigger ${triggerClassName}`.trim()}
      id={controlId}
      type="button"
      role="combobox"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy || (label ? `${labelId} ${controlId}-value` : undefined)}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && active ? `${controlId}-option-${activeIndex}` : undefined}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? errorId : undefined}
      aria-busy={loading || undefined}
      disabled={disabled}
      whileHover={!disabled ? { opacity: 0.96 } : undefined}
      whileTap={!disabled ? { opacity: 0.92 } : undefined}
      transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}
      onClick={() => {
        if (disabled) return;
        if (open) setOpen(false);
        else { setActiveIndex(selectedIndex); setOpen(true); }
      }}
      onKeyDown={handleKeyDown}
    >
      <span className="glass-dropdown__value" id={`${controlId}-value`}>{selected?.label || "Select an option"}</span>
      {loading ? <motion.span className="glass-dropdown__spinner" aria-hidden="true" animate={prefersReducedMotion ? { rotate: 0 } : { rotate: 360 }} transition={{ duration: 0.8, ease: "linear", repeat: prefersReducedMotion ? 0 : Infinity }} /> : <motion.svg className="glass-dropdown__chevron" viewBox="0 0 16 16" aria-hidden="true" animate={{ rotate: open ? 180 : 0 }} transition={{ type: "tween", duration: 0.14, ease: "easeOut" }}><path d="m4 6 4 4 4-4" /></motion.svg>}
    </motion.button>
    {error && <span className="glass-dropdown__message" id={errorId} role="status">{error}</span>}
    {name && <input type="hidden" name={name} value={selected?.value || ""} disabled={disabled} />}
    {typeof document !== "undefined" ? createPortal(menu, document.body) : null}
  </div>;
}
