import { useId, useMemo, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UIBlock, UINumericControl } from '@/lib/generative-ui'
import { compileExpression, evaluateFunction } from '@/lib/function-expression'
import { formatValue, visualButton, visualFocus, visualInput } from './generative-shared'

export function NumericControl({ control, value, onChange }: { control: UINumericControl; value: string | number; onChange: (value: string | number) => void }) {
  const { i18n } = useTranslation('chat')
  const id = useId()
  const valid = value !== '' && Number.isFinite(Number(value)) && Number(value) >= control.min && Number(value) <= control.max
  return <div className="gui-field">
    <label htmlFor={id} className="flex items-center justify-between gap-2 text-xs text-[var(--color-fg-muted)]"><span>{control.label}</span>{control.unit && <span>{control.unit}</span>}</label>
    <div className="flex items-center gap-3">
      {control.type === 'range' && <input type="range" aria-label={control.label} min={control.min} max={control.max} step={control.step} value={Math.max(control.min, Math.min(control.max, Number(value) || 0))} onChange={event => onChange(Number(event.target.value))} className="gui-range min-w-0 flex-1" />}
      <input id={id} type="number" value={value} min={control.min} max={control.max} step={control.step} onChange={event => onChange(event.target.value)} aria-invalid={!valid} aria-valuetext={value === '' ? undefined : formatValue(Number(value), i18n.language)} className={`${visualInput} ${control.type === 'range' ? 'w-24 shrink-0' : 'w-full'}`} />
    </div>
  </div>
}

export function Calculator({ block }: { block: Extract<UIBlock, { type: 'calculator' }> }) {
  const { t, i18n } = useTranslation('chat')
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(block.inputs.map(input => [input.id, input.value])))
  const compiled = useMemo(() => block.outputs.map(output => compileExpression(output.expression, block.inputs.map(input => input.id))), [block.inputs, block.outputs])
  const valid = block.inputs.every(input => {
    const value = values[input.id]
    if (input.type === 'toggle') return typeof value === 'boolean'
    if (input.type === 'select') return input.options.some(option => option.value === value)
    const number = Number(value)
    return value !== '' && Number.isFinite(number) && number >= input.min && number <= input.max
  })
  const numeric = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]))
  const results = compiled.map(expression => valid && expression ? evaluateFunction(expression, numeric) : null)
  const update = (id: string, value: string | number | boolean) => setValues(current => ({ ...current, [id]: value }))
  return <section data-generative-calculator className="gui-calculator min-w-0">
    <div className="flex items-center justify-between gap-3">{block.title && <h3 className="m-0 text-sm font-medium">{block.title}</h3>}<button type="button" className={`ml-auto ${visualButton}`} onClick={() => setValues(Object.fromEntries(block.inputs.map(input => [input.id, input.value])))}><RotateCcw aria-hidden size={14} />{t('generative.reset')}</button></div>
    {block.description && <p className="m-0 text-sm leading-relaxed text-[var(--color-fg-muted)]">{block.description}</p>}
    <div className="gui-fields">
      {block.inputs.map(input => {
        if (input.type === 'toggle') return <label key={input.id} className="gui-toggle"><span>{input.label}</span><input type="checkbox" checked={values[input.id] === true} onChange={event => update(input.id, event.target.checked)} className="gui-check" /></label>
        if (input.type === 'select') return <label key={input.id} className="gui-field text-xs text-[var(--color-fg-muted)]"><span>{input.label}</span><select value={String(values[input.id])} onChange={event => update(input.id, event.target.value)} className={`${visualInput} w-full`}>{input.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        return <NumericControl key={input.id} control={input} value={values[input.id] as string | number} onChange={value => update(input.id, value)} />
      })}
    </div>
    <dl className="gui-results m-0" aria-live="polite" aria-atomic="true">
      {block.outputs.map((output, index) => {
        const result = results[index]
        return <div key={index} className="min-w-0"><dt className="text-xs text-[var(--color-fg-muted)]">{output.label}</dt><dd className="m-0 mt-1 text-lg font-semibold tabular-nums">{result === null ? '—' : formatValue(result, i18n.language, output.precision)}{result !== null && output.unit ? ` ${output.unit}` : ''}</dd></div>
      })}
    </dl>
    {!valid && <p role="status" className="m-0 text-xs text-[var(--color-danger)]">{t('generative.inputInvalid')}</p>}
    {valid && results.some(result => result === null) && <p role="status" className="m-0 text-xs text-[var(--color-fg-muted)]">{t('generative.outputUndefined')}</p>}
  </section>
}

export function Checklist({ block }: { block: Extract<UIBlock, { type: 'checklist' }> }) {
  const { t } = useTranslation('chat')
  const [checked, setChecked] = useState(() => block.items.map(item => item.checked))
  return <section data-generative-checklist className="space-y-3">
    <div className="flex items-center justify-between gap-3">{block.title && <h3 className="m-0 text-sm font-medium">{block.title}</h3>}<span aria-live="polite" className="text-xs tabular-nums text-[var(--color-fg-muted)]">{t('generative.completed', { count: checked.filter(Boolean).length, total: block.items.length })}</span></div>
    <ul className="m-0 list-none space-y-1 p-0">{block.items.map((item, index) => <li key={index}><label className="gui-checklist-row"><input type="checkbox" checked={checked[index]} onChange={event => setChecked(current => current.map((value, i) => i === index ? event.target.checked : value))} className="gui-check" /><span className={checked[index] ? 'text-[var(--color-fg-muted)] line-through' : ''}>{item.text}</span></label></li>)}</ul>
    <button type="button" className={visualButton} onClick={() => setChecked(block.items.map(item => item.checked))}><RotateCcw aria-hidden size={14} />{t('generative.reset')}</button>
  </section>
}

export function Quiz({ block }: { block: Extract<UIBlock, { type: 'quiz' }> }) {
  const { t } = useTranslation('chat')
  const [choice, setChoice] = useState<number | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const id = useId()
  return <section data-generative-quiz className="space-y-3">
    <fieldset className="m-0 min-w-0 border-0 p-0"><legend className="mb-3 text-sm font-medium">{block.question}</legend>
      <div className="space-y-1.5">{block.options.map((option, index) => <label key={index} className={`gui-quiz-option ${choice === index ? 'gui-selected' : ''}`}><input type="radio" name={id} value={index} checked={choice === index} disabled={submitted} onChange={() => setChoice(index)} className="gui-check" /><span className="min-w-0 flex-1">{option}</span>{submitted && index === block.answer && <Check aria-label={t('generative.correctAnswer')} size={16} className="text-[var(--color-success)]" />}</label>)}</div>
    </fieldset>
    {submitted && <div role="status" className="gui-feedback"><p className={`m-0 text-sm font-medium ${choice === block.answer ? 'text-[var(--color-success)]' : 'text-[var(--color-fg)]'}`}>{t(choice === block.answer ? 'generative.correct' : 'generative.incorrect')}</p>{block.explanation && <p className="m-0 mt-1 text-sm text-[var(--color-fg-muted)]">{block.explanation}</p>}</div>}
    <button type="button" className={`${visualButton} ${visualFocus}`} disabled={choice === null} onClick={() => submitted ? (setSubmitted(false), setChoice(null)) : setSubmitted(true)}>{t(submitted ? 'generative.tryAgain' : 'generative.checkAnswer')}</button>
  </section>
}
