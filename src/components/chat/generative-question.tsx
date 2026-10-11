import { useId, useRef, useState } from 'react'
import { Check, Loader2, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UIBlock } from '@/lib/generative-ui'
import { useGenerativeReply } from './generative-reply-context'
import { visualFocus, visualInput } from './generative-shared'

type QuestionBlock = Extract<UIBlock, { type: 'question' }>
interface Answer { options: number[]; other: boolean; text: string }

export function QuestionSelector({ block, live }: { block: QuestionBlock; live: boolean }) {
  const { t } = useTranslation('chat')
  const id = useId()
  const reply = useGenerativeReply()
  const [answers, setAnswers] = useState<Answer[]>(() => block.questions.map(() => ({ options: [], other: false, text: '' })))
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)
  const sending = useRef(false)
  const status = live ? 'streaming' : reply.status
  const locked = pending || sent || status !== 'ready' || !reply.submit
  const complete = block.questions.every((_, index) => {
    const answer = answers[index]
    return answer && (answer.options.length > 0 || (answer.other && answer.text.trim().length > 0)) && (!answer.other || answer.text.trim().length > 0)
  })

  const update = (index: number, next: (answer: Answer) => Answer) => {
    setFailed(false)
    setAnswers(current => current.map((answer, i) => i === index ? next(answer) : answer))
  }

  async function submit() {
    if (locked || !complete || sending.current || !reply.submit) return
    sending.current = true
    setPending(true)
    setFailed(false)
    const lines = block.questions.map((question, index) => {
      const answer = answers[index]
      const selected = question.options.filter((_, optionIndex) => answer.options.includes(optionIndex)).map(option => option.label)
      if (answer.other) selected.push(answer.text.trim())
      return `${index + 1}. ${question.question}\n${selected.map(text => `- ${text}`).join('\n')}`
    })
    try {
      if (await reply.submit(`${t('generative.answerIntro')}\n\n${lines.join('\n\n')}`)) setSent(true)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      sending.current = false
      setPending(false)
    }
  }

  const feedback = pending ? 'questionSending' : sent ? 'questionSent' : status === 'streaming' ? 'questionStreaming' : status === 'answered' ? 'questionAnswered' : status === 'readonly' || !reply.submit ? 'questionReadonly' : 'questionHint'
  return <section data-generative-question className="min-w-0" aria-busy={pending}>
    {block.title && <h3 className="m-0 text-sm font-medium">{block.title}</h3>}
    {block.questions.map((question, index) => {
      const answer = answers[index] ?? { options: [], other: false, text: '' }
      const group = `${id}-${question.id}`
      return <fieldset key={question.id} disabled={locked} className="gui-question-group m-0 min-w-0 border-0 p-0">
        <legend className="mb-3 w-full text-sm font-medium"><span>{question.question}</span><span className="ml-2 text-xs font-normal text-[var(--color-fg-muted)]">{t(question.multiple ? 'generative.chooseMany' : 'generative.chooseOne')}</span></legend>
        <div className="gui-question-options">
          {question.options.map((option, optionIndex) => {
            const selected = answer.options.includes(optionIndex)
            return <label key={optionIndex} className={`gui-question-option ${selected ? 'gui-selected' : ''}`}>
              <input type={question.multiple ? 'checkbox' : 'radio'} name={group} value={optionIndex} checked={selected} className={`gui-check ${visualFocus}`} onChange={event => update(index, current => ({
                ...current,
                options: question.multiple ? event.target.checked ? [...current.options, optionIndex] : current.options.filter(item => item !== optionIndex) : [optionIndex],
                other: question.multiple && current.other,
              }))} />
              <span className="min-w-0 flex-1"><span className="block text-sm">{option.label}</span>{option.description && <span className="mt-1 block text-xs leading-relaxed text-[var(--color-fg-muted)]">{option.description}</span>}</span>
            </label>
          })}
          {question.allowCustom && <label className={`gui-question-option ${answer.other ? 'gui-selected' : ''}`}>
            <input type={question.multiple ? 'checkbox' : 'radio'} name={group} value="other" checked={answer.other} className={`gui-check ${visualFocus}`} onChange={event => update(index, current => ({ ...current, other: event.target.checked, options: question.multiple ? current.options : [] }))} />
            <span className="text-sm">{t('generative.otherAnswer')}</span>
          </label>}
        </div>
        {question.allowCustom && answer.other && <label className="gui-field mt-3 text-xs text-[var(--color-fg-muted)]"><span>{t('generative.customAnswer')}</span><textarea autoFocus rows={2} maxLength={1000} value={answer.text} onChange={event => update(index, current => ({ ...current, text: event.target.value }))} placeholder={t('generative.customAnswerPlaceholder')} className={`${visualInput} gui-question-textarea w-full resize-y`} /></label>}
      </fieldset>
    })}
    <div className="flex flex-wrap items-center gap-3">
      {reply.submit && status !== 'readonly' && (status !== 'answered' || pending || sent) && <button type="button" disabled={locked || !complete} onClick={() => void submit()} className={`gui-question-submit ${visualFocus}`}>
        {pending ? <Loader2 size={14} aria-hidden className="animate-spin motion-reduce:animate-none" /> : sent ? <Check size={14} aria-hidden /> : <Send size={14} aria-hidden />}
        {t(sent ? 'generative.questionSent' : pending ? 'generative.questionSending' : 'generative.sendAnswers')}
      </button>}
      <p role="status" className={`gui-question-feedback m-0 text-xs leading-relaxed ${!failed && (pending || sent) ? 'sr-only' : ''} ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-fg-muted)]'}`}>{t(`generative.${failed ? 'questionFailed' : feedback}`)}</p>
    </div>
  </section>
}
