import { Fragment } from 'react'

export interface Row {
  id: string
  label: string
}

export function RowList({ rows }: { rows: Row[] }) {
  return (
    <div>
      {rows.map((r) => (
        <Fragment key={r.id}>
          <dt>{r.label}</dt>
          <dd>{r.id}</dd>
        </Fragment>
      ))}
    </div>
  )
}