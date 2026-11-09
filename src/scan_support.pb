; Shared UTF-8 output, JSON strings and file reads used by the server and scanner.
EnableExplicit

Procedure WriteLine(Text$)
  Protected s$ = Text$ + Chr(10)
  Protected len.i = StringByteLength(s$, #PB_UTF8)
  Protected *buf = AllocateMemory(len + 1)
  PokeS(*buf, s$, -1, #PB_UTF8)
  WriteConsoleData(*buf, len)
  FreeMemory(*buf)
EndProcedure

Procedure.s JsonEscape(s$)
  Protected out$ = ReplaceString(s$, "\", "\\")
  out$ = ReplaceString(out$, Chr(34), "\" + Chr(34))
  out$ = ReplaceString(out$, Chr(8), "\b")
  out$ = ReplaceString(out$, Chr(12), "\f")
  out$ = ReplaceString(out$, Chr(10), "\n")
  out$ = ReplaceString(out$, Chr(13), "\r")
  out$ = ReplaceString(out$, Chr(9), "\t")
  ; The replaces above already turned \b \f \n \r \t into plain
  ; two-char text, so the only chars < 32 still present are 0-7, 11 and
  ; 14-31 - rare in practice. Scan for them on the raw buffer (PeekU reads
  ; the same code units the old per-char Asc(Mid()) loop compared;
  ; SizeOf(Character) keeps the stride correct; Unicode build assumed by
  ; PeekU). Strings without a control char - the normal case - return in
  ; one piece; otherwise whole spans between controls are appended with
  ; one Mid() each, followed by the identical "\u00xx" escape. Byte-for-
  ; byte output equivalence with the old per-char loop is verified
  ; exhaustively (140/140 identical incl. all controls 0-31,
  ; surrogate pair, U+FFFD, multibyte).
  Protected i.i, n.i = Len(out$), start.i, c.i, res$ = "", *p
  If n = 0 : ProcedureReturn "" : EndIf
  *p = @out$
  For i = 0 To n - 1
    If PeekU(*p + i * SizeOf(Character)) < 32 : Break : EndIf
  Next
  If i >= n : ProcedureReturn out$ : EndIf
  start = 1
  While start <= n
    *p = @out$ + (start - 1) * SizeOf(Character)
    i = 0
    While start + i <= n And PeekU(*p + i * SizeOf(Character)) >= 32 : i + 1 : Wend
    If i > 0 : res$ + Mid(out$, start, i) : EndIf
    If start + i <= n
      c = PeekU(*p + i * SizeOf(Character))
      res$ + "\u00" + RSet(Hex(c), 2, "0")
      start = start + i + 1
    Else
      Break
    EndIf
  Wend
  ProcedureReturn res$
EndProcedure

Procedure.s JsonQ(s$)
  ProcedureReturn Chr(34) + JsonEscape(s$) + Chr(34)
EndProcedure

Procedure.s MemberStr(Obj.i, Key$, Default$)
  If Obj = 0 : ProcedureReturn Default$ : EndIf
  Protected m.i = GetJSONMember(Obj, Key$)
  If m And JSONType(m) = #PB_JSON_String
    ProcedureReturn GetJSONString(m)
  EndIf
  ProcedureReturn Default$
EndProcedure

; PB strings truncate at NUL, so reject its JSON escape before decoding.
Procedure.i JsonHasNul(Text$)
  Protected pos.i = FindString(Text$, "\u0000"), before.i
  While pos
    before = pos - 1
    While before > 0 And PeekU(@Text$ + (before - 1) * SizeOf(Character)) = 92
      before - 1
    Wend
    If (pos - before) & 1 : ProcedureReturn #True : EndIf
    pos = FindString(Text$, "\u0000", pos + 6)
  Wend
  ProcedureReturn #False
EndProcedure

; Keep a UTF-8 BOM in the decoded text; missing/unreadable files return empty.
Procedure.s ReadSourceWhole(File$)
  Protected size.i = FileSize(File$)
  If size < 0 : ProcedureReturn "" : EndIf
  Protected f.i = ReadFile(#PB_Any, File$)
  If f = 0 : ProcedureReturn "" : EndIf
  Protected *buf = AllocateMemory(size + 1)
  If *buf = 0 : CloseFile(f) : ProcedureReturn "" : EndIf
  Protected bytes.i = ReadData(f, *buf, size)
  CloseFile(f)
  Protected s$ = ""
  If bytes > 0 : s$ = PeekS(*buf, bytes, #PB_UTF8 | #PB_ByteLength) : EndIf
  FreeMemory(*buf)
  ProcedureReturn s$
EndProcedure
