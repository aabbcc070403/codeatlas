export interface Row {
  id: string
  label: string
}

export function RowList({ rows }: { rows: Row[] }) {
  return (
    <div>
      {rows.map((r) => (
        <>
          <dt>{r.label}</dt>
          <dd>{r.id}</dd>
        </>
      ))}
    </div>
  )
}