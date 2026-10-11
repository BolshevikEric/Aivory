import { useId, useRef, useState, type FormEvent } from 'react'
import { Check, Loader2, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UIBlock } from '@/lib/generative-ui'
import { useGenerativeReply } from './generative-reply-context'
import { visualFocus, visualInput } from './generative-shared'

type FormBlock = Extract<UIBlock, { type: 'form' }>
type FieldValue = string | boolean | string[]
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

export function GenerativeForm({ block, live }: { block: FormBlock; live: boolean }) {
  const { t } = useTranslation('chat')
  const id = useId()
  const reply = useGenerativeReply()
  const form = useRef<HTMLFormElement>(null)
  const sending = useRef(false)
  const [values, setValues] = useState<Record<string, FieldValue>>(() => Object.fromEntries(block.fields.map(field => [field.id, field.value === undefined ? '' : typeof field.value === 'number' ? String(field.value) : field.value])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)
  const status = live ? 'streaming' : reply.status
  const locked = pending || sent || status !== 'ready' || !reply.submit

  function update(fieldId: string, value: FieldValue) {
    setValues(current => ({ ...current, [fieldId]: value }))
    setErrors(current => {
      const next = { ...current }
      delete next[fieldId]
      return next
    })
    setFailed(false)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked || sending.current || !reply.submit || !form.current) return
    const controls = Array.from(form.current.querySelectorAll<FormControl>('input, textarea, select'))
    controls.forEach(control => control.setCustomValidity(''))
    for (const field of block.fields) {
      const value = values[field.id]
      if (field.required && ((typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length))) {
        controls.find(control => control.dataset.fieldId === field.id)?.setCustomValidity(t('generative.formRequired'))
      }
    }
    const invalid = controls.filter(control => !control.validity.valid)
    if (invalid.length) {
      setErrors(Object.fromEntries(invalid.map(control => {
        const field = block.fields.find(field => field.id === control.dataset.fieldId)!
        const validity = control.validity
        const message = validity.valueMissing || validity.customError ? t('generative.formRequired')
          : validity.typeMismatch ? t(field.type === 'email' ? 'generative.formEmail' : 'generative.formURL')
          : field.type === 'number' && validity.rangeUnderflow ? t('generative.formMin', { value: field.min })
          : field.type === 'number' && validity.rangeOverflow ? t('generative.formMax', { value: field.max })
          : field.type === 'number' && validity.stepMismatch ? t('generative.formStep', { step: field.step })
          : 'maxLength' in field && validity.tooLong ? t('generative.formTooLong', { count: field.maxLength })
          : t('generative.formInvalid')
        return [field.id, message]
      })))
      invalid[0].focus()
      return
    }
    sending.current = true
    setPending(true)
    setFailed(false)
    const lines = block.fields.map((field, index) => {
      const value = values[field.id]
      let answer: string
      if (field.type === 'checkbox') answer = t(value ? 'generative.formYes' : 'generative.formNo')
      else if (field.type === 'checkboxes') answer = field.options.filter(option => Array.isArray(value) && value.includes(option.value)).map(option => `- ${option.label}`).join('\n')
      else if (field.type === 'select' || field.type === 'radio') answer = field.options.find(option => option.value === value)?.label ?? ''
      else answer = typeof value === 'string' ? value.trim() : ''
      return `${index + 1}. ${field.label}\n${answer || t('generative.formEmpty')}`
    })
    const message = `${t('generative.formIntro')}${block.title ? `\n${block.title}` : ''}\n\n${lines.join('\n\n')}`
    try {
      if (await reply.submit(message)) setSent(true)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      sending.current = false
      setPending(false)
    }
  }

  const feedback = pending ? 'formSending' : sent ? 'formSent' : status === 'streaming' ? 'formStreaming' : status === 'answered' ? 'formAnswered' : status === 'readonly' || !reply.submit ? 'formReadonly' : 'formHint'
  return <form ref={form} data-generative-form className="min-w-0" noValidate aria-busy={pending} onSubmit={event => void submit(event)}>
    {(block.title || block.description) && <div className="gui-form-heading">
      {block.title && <h3 className="m-0 text-sm font-medium">{block.title}</h3>}
      {block.description && <p className="m-0 text-xs leading-relaxed text-[var(--color-fg-muted)]">{block.description}</p>}
    </div>}
    <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{block.title || t('generative.formTitle')}</legend>
      <div className="gui-fields">
        {block.fields.map(field => {
          const fieldId = `${id}-${field.id}`, value = values[field.id]
          const error = errors[field.id]
          const label = <span>{field.label}{field.required && <span className="ml-1 text-xs font-normal text-[var(--color-fg-muted)]">{t('generative.formRequiredLabel')}</span>}</span>
          const describedBy = [field.description && `${fieldId}-help`, error && `${fieldId}-error`].filter(Boolean).join(' ') || undefined
          const attributes = { id: fieldId, name: field.id, 'data-field-id': field.id, 'aria-describedby': describedBy, 'aria-invalid': !!error }
          const details = <>
            {field.description && <span id={`${fieldId}-help`} className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{field.description}</span>}
            {error && <span id={`${fieldId}-error`} role="alert" className="text-xs text-[var(--color-danger)]">{error}</span>}
          </>
          if (field.type === 'radio' || field.type === 'checkboxes') return <fieldset key={field.id} data-form-field={field.id} className="gui-form-wide gui-field m-0 min-w-0 border-0 p-0" aria-describedby={describedBy} aria-required={field.required}>
            <legend className="mb-2 text-sm font-medium">{label}</legend>
            <div className="gui-form-options">
              {field.options.map((option, index) => <label key={option.value} className="gui-form-option">
                <input {...attributes} id={`${fieldId}-${index}`} type={field.type === 'radio' ? 'radio' : 'checkbox'} value={option.value} checked={field.type === 'radio' ? value === option.value : Array.isArray(value) && value.includes(option.value)} required={field.type === 'radio' && field.required} className={`gui-check ${visualFocus}`} onChange={event => update(field.id, field.type === 'radio' ? option.value : event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : Array.isArray(value) ? value.filter(item => item !== option.value) : [])} />
                <span>{option.label}</span>
              </label>)}
            </div>{details}
          </fieldset>
          if (field.type === 'checkbox') return <div key={field.id} data-form-field={field.id} className="gui-form-wide gui-field">
            <label htmlFor={fieldId} className="gui-form-option"><input {...attributes} type="checkbox" required={field.required} checked={value === true} className={`gui-check ${visualFocus}`} onChange={event => update(field.id, event.target.checked)} />{label}</label>{details}
          </div>
          return <div key={field.id} data-form-field={field.id} className={`gui-field ${field.type === 'textarea' ? 'gui-form-wide' : ''}`}>
            <label htmlFor={fieldId} className="text-sm font-medium">{label}</label>
            {field.type === 'select' ? <select {...attributes} required={field.required} value={typeof value === 'string' ? value : ''} className={`${visualInput} w-full`} onChange={event => update(field.id, event.target.value)}>
              <option value="" disabled={field.required}>{t('generative.formSelect')}</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select> : field.type === 'textarea' ? <textarea {...attributes} required={field.required} rows={3} maxLength={field.maxLength} placeholder={field.placeholder} value={typeof value === 'string' ? value : ''} className={`${visualInput} gui-form-textarea w-full resize-y`} onChange={event => update(field.id, event.target.value)} /> : <input {...attributes} type={field.type} required={field.required} placeholder={'placeholder' in field ? field.placeholder : undefined} value={typeof value === 'string' ? value : ''} min={field.type === 'number' ? field.min : undefined} max={field.type === 'number' ? field.max : undefined} step={field.type === 'number' ? field.step ?? 'any' : field.type === 'time' || field.type === 'datetime-local' ? 'any' : undefined} maxLength={'maxLength' in field ? field.maxLength : undefined} className={`${visualInput} w-full`} onChange={event => update(field.id, event.target.value)} />}
            {details}
          </div>
        })}
      </div>
    </fieldset>
    <div className="flex flex-wrap items-center gap-3">
      {reply.submit && status !== 'readonly' && (status !== 'answered' || pending || sent) && <button type="submit" disabled={locked} className={`gui-question-submit ${visualFocus}`}>
        {pending ? <Loader2 size={14} aria-hidden className="animate-spin motion-reduce:animate-none" /> : sent ? <Check size={14} aria-hidden /> : <Send size={14} aria-hidden />}
        {pending ? t('generative.formSending') : sent ? t('generative.formSent') : block.submitLabel || t('generative.sendForm')}
      </button>}
      <p role="status" className={`gui-form-feedback text-xs ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]'} ${pending || sent ? 'sr-only' : ''}`}>{t(`generative.${failed ? 'formFailed' : feedback}`)}</p>
    </div>
  </form>
}
