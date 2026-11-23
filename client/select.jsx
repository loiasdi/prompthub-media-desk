import React from 'react'
import * as Popover from '@radix-ui/react-popover'
import { t } from './i18n.js'

function optionText(node) {
  return React.Children.toArray(node).map(child => React.isValidElement(child) ? optionText(child.props.children) : String(child)).join('')
}

function readOptions(children, disabled = false) {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement(child)) return []
    if (child.type !== 'option') return readOptions(child.props.children, disabled || child.props.disabled)
    const label = optionText(child.props.children)
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || child.props.disabled }]
  })
}

function Mark({ checked = false, close = false }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={close ? 'M6 6l12 12M18 6L6 18' : checked ? 'M5 12l4 4L19 6' : 'M6 9l6 6 6-6'} /></svg>
}

export function Select({ value = '', onChange, children, options: suppliedOptions, multiple = false, disabled = false, placeholder, searchable, className = '', id: suppliedId, name, required, 'aria-label': ariaLabel }) {
  const uid = React.useId(), id = suppliedId || `md-select-${uid}`
  const trigger = React.useRef(null), search = React.useRef(null), list = React.useRef(null)
  const [open, setOpen] = React.useState(false), [query, setQuery] = React.useState(''), [active, setActive] = React.useState(-1)
  const [container, setContainer] = React.useState(null), [fieldLabel, setFieldLabel] = React.useState('')
  const options = suppliedOptions || readOptions(children)
  const values = multiple ? (Array.isArray(value) ? value : []) : [String(value)]
  const chosen = values.map(value => options.find(option => option.value === value)).filter(Boolean)
  const canSearch = searchable ?? (multiple || options.length > 6 || options.some(option => option.thumbnail))
  const matches = (option, query) => `${option.label} ${(option.badges || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())
  const filtered = options.filter(option => matches(option, query))
  const label = ariaLabel || fieldLabel || placeholder || t('请选择')
  const change = next => onChange?.({ target: { value: next, name }, currentTarget: { value: next, name } })
  const toggle = option => {
    if (!option || option.disabled || disabled) return
    if (multiple) change(values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value])
    else { change(option.value); setOpen(false) }
  }
  const openChange = next => {
    if (next && (disabled || trigger.current?.matches(':disabled'))) return
    setContainer(trigger.current?.closest('.md-root') || null)
    setFieldLabel(trigger.current?.closest('label')?.querySelector(':scope > span')?.textContent || '')
    setQuery('')
    const selected = options.findIndex(option => values.includes(option.value) && !option.disabled)
    setActive(selected >= 0 ? selected : options.findIndex(option => !option.disabled))
    setOpen(Boolean(next))
  }
  React.useEffect(() => { setFieldLabel(trigger.current?.closest('label')?.querySelector(':scope > span')?.textContent || '') }, [ariaLabel, children, suppliedOptions])
  React.useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  React.useEffect(() => { if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  const keyDown = event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (!canSearch || !['Home', 'End'].includes(event.key))) {
      event.preventDefault()
      const enabled = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
      const position = enabled.indexOf(active), direction = event.key === 'ArrowUp' ? -1 : 1
      if (!enabled.length) { setActive(-1); return }
      setActive(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[position < 0 ? direction > 0 ? 0 : enabled.length - 1 : (position + direction + enabled.length) % enabled.length] ?? -1)
    } else if (event.key === 'Enter' || (!canSearch && event.key === ' ')) {
      event.preventDefault(); toggle(filtered[active])
    } else if (!canSearch && event.key.length === 1) {
      const index = filtered.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(event.key.toLowerCase()))
      if (index >= 0) setActive(index)
    }
  }
  const badges = option => option.badges?.length ? <span className="md-select-badges">{option.badges.map((badge, index) => <span key={index}>{badge}</span>)}</span> : null
  return <div className={`md-select ${multiple ? 'is-multiple' : ''} ${className}`}>
    {required || name ? <input className="md-sr" tabIndex={-1} aria-hidden="true" name={name} value={multiple ? values.join(',') : value} onChange={() => {}} required={required} disabled={disabled} onInvalid={event => { event.preventDefault(); trigger.current?.focus(); openChange(true) }} /> : null}
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger asChild>
        <button ref={trigger} id={id} type="button" disabled={disabled} className="md-select-trigger" aria-label={label} aria-haspopup="listbox" aria-required={required || undefined} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openChange(true) } }}>
          {!multiple && chosen[0]?.thumbnail ? <img className="md-select-thumb" src={chosen[0].thumbnail} alt="" /> : null}
          <span className={!chosen.length || (!multiple && !value) ? 'md-select-placeholder' : ''}>{multiple ? chosen.length ? t('已选 {count} 张封面', { count: chosen.length }) : placeholder || t('请选择') : chosen[0]?.label || placeholder || t('请选择')}</span>
          {!multiple && chosen[0] ? badges(chosen[0]) : null}<Mark />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content className="md-select-popover" align="start" sideOffset={6} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); (search.current || list.current)?.focus() }} onCloseAutoFocus={event => { if (trigger.current?.ownerDocument.activeElement?.closest('.md-select-popover')) event.preventDefault() }}>
          {canSearch ? <div className="md-select-search"><input ref={search} type="search" role="combobox" aria-label={t('搜索选项')} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={active >= 0 && filtered[active] ? `${id}-option-${active}` : undefined} placeholder={t('搜索名称、类型或比例')} value={query} onChange={event => { setQuery(event.target.value); setActive(options.filter(option => matches(option, event.target.value)).findIndex(option => !option.disabled)) }} onKeyDown={keyDown} /></div> : null}
          <div ref={list} id={`${id}-list`} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} tabIndex={canSearch ? -1 : 0} aria-activedescendant={active >= 0 && filtered[active] ? `${id}-option-${active}` : undefined} className="md-select-options" onKeyDown={canSearch ? undefined : keyDown}>
            {filtered.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={values.includes(option.value)} aria-disabled={Boolean(option.disabled)} data-active={active === index} className="md-select-option" onPointerMove={() => { if (!option.disabled) setActive(index) }} onPointerDown={event => event.preventDefault()} onClick={() => toggle(option)}>
              {multiple ? <span className={`md-select-checkbox ${values.includes(option.value) ? 'is-checked' : ''}`}>{values.includes(option.value) ? <Mark checked /> : null}</span> : null}
              {option.thumbnail ? <img className="md-select-thumb" src={option.thumbnail} alt="" loading="lazy" /> : null}
              <span className="md-select-option-name" title={option.label}>{option.label}</span>{badges(option)}
              {!multiple && values.includes(option.value) ? <Mark checked /> : null}
            </div>)}
            {!filtered.length ? <p className="md-select-empty">{t('没有匹配的选项')}</p> : null}
          </div>
          {multiple ? <footer className="md-select-footer"><span>{t('已选 {count} 张封面', { count: chosen.length })}</span><Popover.Close asChild><button type="button" className="md-btn is-small">{t('完成')}</button></Popover.Close></footer> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {multiple && chosen.length ? <div className="md-select-selection">{chosen.map((option, index) => <div className="md-select-chip" key={option.value}>
      {option.thumbnail ? <img className="md-select-thumb" src={option.thumbnail} alt="" /> : null}<span title={option.label}>{option.label}</span>{badges(option)}
      {index === 0 ? <span className="md-select-badges"><span>{t('默认封面')}</span></span> : null}
      <button type="button" disabled={disabled} aria-label={t('移除 {name}', { name: option.label })} onClick={() => change(values.filter(value => value !== option.value))}><Mark close /></button>
    </div>)}</div> : null}
  </div>
}
