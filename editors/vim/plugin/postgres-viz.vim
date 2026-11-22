if exists('g:loaded_postgres_viz')
  finish
endif
let g:loaded_postgres_viz = 1
let s:save_cpo = &cpoptions
set cpoptions&vim
let s:jobs = {}

function! s:show_error(message) abort
  echohl ErrorMsg
  echomsg 'Postgres Viz: ' . a:message
  echohl None
endfunction

function! s:exited(state, job, status) abort
  call remove(s:jobs, a:state.id)
  if a:status != 0
    call s:show_error(printf('%s failed (exit %d)', a:state.command, a:status))
  endif
endfunction

function! s:show_message(channel, message) abort
  echomsg 'Postgres Viz: ' . a:message
endfunction

function! s:run(command, args) abort
  if !exists('*job_start')
    call s:show_error('Vim was built without job support.')
    return
  endif
  if !executable('postgres-viz')
    call s:show_error('postgres-viz is missing from PATH. Install the CLI and restart Vim.')
    return
  endif
  let s:next_id = get(s:, 'next_id', 0) + 1
  let state = {'id': s:next_id, 'command': a:command}
  let job = job_start(['postgres-viz', a:command] + a:args, {
        \ 'err_cb': function('s:show_message'),
        \ 'out_cb': function('s:show_message'),
        \ 'exit_cb': function('s:exited', [state]),
        \ })
  if job_status(job) ==# 'fail'
    call s:show_error('Could not start postgres-viz.')
  else
    let s:jobs[state.id] = job
  endif
endfunction

function! s:open(path) abort
  if a:path !~# '\.pgviz\.json$'
    call s:show_error('Open a saved .pgviz.json snapshot first.')
    return
  endif
  call s:run('open', [a:path])
endfunction

function! s:scan(path) abort
  call s:run('scan', ['--out', fnamemodify(a:path, ':p')])
endfunction

command! PostgresVizOpen call s:open(expand('%:p'))
command! -nargs=1 -complete=file PostgresVizScan call s:scan(<q-args>)

let &cpoptions = s:save_cpo
unlet s:save_cpo
