; ---------------------------------------------------------------------------
; jsonrpc.pb - JSON-RPC 2.0 request parse + response/error builders.
;
; Provenance: adapted from mcp-pb-spike-640/mcp_server.pb (protocol core
; verified 8/8 on PB 6.40). The tool hooks (ToolList / ToolDispatch) are
; declared here and implemented in tools.pb to break the include cycle.
; ---------------------------------------------------------------------------
EnableExplicit

Declare ToolList(IdValue.i)
Declare ToolDispatch(IdValue.i, Params.i)

#PROTOCOL_VERSION$ = "2025-03-26"
#HTTP_PROTOCOL_VERSION$ = "2025-11-25"
Global gHttpMode.i = #False
Global gHttpAllowCompilerTools.i = #False
Global gHttpCapturedResponse.s = ""
#SERVER_NAME$      = "purebasic-mcp-pb"
#SERVER_VERSION$   = "0.4.0"   ; 0.4.0: Streamable HTTP transport (pbmcp http), project staging for pb_check/pb_run, preload default off on non-TS builds

Global gBatchActive.i = #False
Global gBatchResponses$ = ""

CompilerIf Not Defined(PBMCP_REVISION$, #PB_Constant)
  #PBMCP_REVISION$ = "unknown"
CompilerEndIf

; Build scripts inject the revision; direct/compiler-only builds stay usable.
Procedure.s ServerVersionFull()
  ProcedureReturn #SERVER_VERSION$ + " (build " + FormatDate("%yyyy-%mm-%dd", #PB_Compiler_Date) + "; revision " + #PBMCP_REVISION$ + ")"
EndProcedure
; NO global output cap: truncation happens inside the formatters (docs
; search 8000 / command 14000 / check 8000 / run caps) - a global cap here
; would clip long pb_run results that fit under their per-tool caps.

; ---------------------------------------------------------------------------
; JSON string escaping (shared with metrics.pb; metrics.pb used to carry a
; private copy, hoisted here).
; ---------------------------------------------------------------------------
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

; ---------------------------------------------------------------------------
; response builders
; ---------------------------------------------------------------------------
Procedure CopyId(IdValue.i, Root.i)
  Protected m.i = AddJSONMember(Root, "id")
  Select JSONType(IdValue)
    Case #PB_JSON_Number
      SetJSONInteger(m, GetJSONInteger(IdValue))
    Case #PB_JSON_String
      SetJSONString(m, GetJSONString(IdValue))
    Default
      SetJSONNull(m)
  EndSelect
EndProcedure

; Response doc with jsonrpc + id (if any) + empty "result" object.
; Reach the result via GetJSONMember(JSONValue(json), "result").
Procedure.i BeginResponse(IdValue.i)
  Protected json.i = CreateJSON(#PB_Any)
  If json = 0 : End 1 : EndIf   ; OOM: no response can be built
  Protected root.i = JSONValue(json)
  SetJSONObject(root)
  SetJSONString(AddJSONMember(root, "jsonrpc"), "2.0")
  If IdValue
    CopyId(IdValue, root)
  EndIf
  Protected res.i = AddJSONMember(root, "result")
  SetJSONObject(res)
  ProcedureReturn json
EndProcedure

Procedure.s ActiveProtocolVersion()
  If gHttpMode : ProcedureReturn #HTTP_PROTOCOL_VERSION$ : EndIf
  ProcedureReturn #PROTOCOL_VERSION$
EndProcedure

Procedure FinishResponse(json.i)
  Protected response$ = ComposeJSON(json)
  If gHttpMode
    gHttpCapturedResponse = response$
  Else
    WriteLine(response$)
  EndIf
  FreeJSON(json)
EndProcedure

Procedure SendError(IdValue.i, Code.i, Message$)
  Protected json.i = CreateJSON(#PB_Any)
  If json = 0 : End 1 : EndIf   ; OOM: no error response can be built
  Protected root.i = JSONValue(json)
  SetJSONObject(root)
  SetJSONString(AddJSONMember(root, "jsonrpc"), "2.0")
  If IdValue
    CopyId(IdValue, root)
  Else
    SetJSONNull(AddJSONMember(root, "id"))
  EndIf
  Protected err.i = AddJSONMember(root, "error")
  SetJSONObject(err)
  SetJSONInteger(AddJSONMember(err, "code"), Code)
  SetJSONString(AddJSONMember(err, "message"), Message$)
  FinishResponse(json)
EndProcedure

; tools/call result with a single text content item
Procedure SendTextResult(IdValue.i, Text$, IsError.i)
  Protected json.i = BeginResponse(IdValue)
  Protected result.i = GetJSONMember(JSONValue(json), "result")
  Protected content.i = AddJSONMember(result, "content")
  SetJSONArray(content)
  Protected item.i = AddJSONElement(content)
  SetJSONObject(item)
  SetJSONString(AddJSONMember(item, "type"), "text")
  SetJSONString(AddJSONMember(item, "text"), Text$)
  SetJSONBoolean(AddJSONMember(result, "isError"), IsError)
  FinishResponse(json)
EndProcedure

Procedure.s MemberStr(Obj.i, Key$, Default$)
  If Obj = 0 : ProcedureReturn Default$ : EndIf
  Protected m.i = GetJSONMember(Obj, Key$)
  If m And JSONType(m) = #PB_JSON_String
    ProcedureReturn GetJSONString(m)
  EndIf
  ProcedureReturn Default$
EndProcedure

; invalid_type wording for "Expected X, received Y": JSON type -> name
Procedure.s JsonTypeName(Value.i)
  Select JSONType(Value)
    Case #PB_JSON_String  : ProcedureReturn "string"
    Case #PB_JSON_Number  : ProcedureReturn "number"
    Case #PB_JSON_Boolean : ProcedureReturn "boolean"
    Case #PB_JSON_Null    : ProcedureReturn "null"
    Case #PB_JSON_Array   : ProcedureReturn "array"
  EndSelect
  ProcedureReturn "object"
EndProcedure

; ---------------------------------------------------------------------------
; argument validators (single-sourced here: jsonrpc.pb is included before
; every user — tools.pb, tool_check.pb, tool_run.pb)
; ---------------------------------------------------------------------------

; Required/optional string prop.
; Returns "" when valid and fills *out\s; else the issue text. Optional
; (= Required #False): absent is VALID and yields "" - a bare "Required at
; <key>" for the optional 'library' was wrong (found while
; writing the harness; only truly required props report Required).
Procedure.s ValidateStrArg(Args.i, Key$, MaxLen.i, Required.i, *out.String)
  Protected m.i = 0
  If Args : m = GetJSONMember(Args, Key$) : EndIf
  If m = 0
    If Required : ProcedureReturn "Required at " + Key$ : EndIf
    *out\s = ""
    ProcedureReturn ""
  ElseIf JSONType(m) <> #PB_JSON_String
    ProcedureReturn "Expected string, received " + JsonTypeName(m) + " at " + Key$
  ElseIf GetJSONString(m) = ""
    ProcedureReturn "String must contain at least 1 character(s) at " + Key$
  ElseIf MaxLen > 0 And Len(GetJSONString(m)) > MaxLen
    ProcedureReturn "String must contain at most " + Str(MaxLen) + " character(s) at " + Key$
  EndIf
  *out\s = GetJSONString(m)
  ProcedureReturn ""
EndProcedure

; Optional integer prop in [MinV, MaxV] (absent = default). "" = valid.
; The caller presets *outVal\i with the default - absent leaves it untouched.
Procedure.s ValidateIntArg(Args.i, Key$, MinV.i, MaxV.i, *outVal.Integer)
  If Args = 0 : ProcedureReturn "" : EndIf
  Protected m.i = GetJSONMember(Args, Key$)
  If m = 0 : ProcedureReturn "" : EndIf
  If JSONType(m) <> #PB_JSON_Number
    ProcedureReturn "Expected number, received " + JsonTypeName(m) + " at " + Key$
  EndIf
  Protected d.d = GetJSONDouble(m)
  If d <> Int(d)
    ProcedureReturn "Expected integer, received " + StrD(d) + " at " + Key$
  EndIf
  Protected v.i = Int(d)
  If v < MinV
    ProcedureReturn "Number must be greater than or equal to " + Str(MinV) + " at " + Key$
  EndIf
  If v > MaxV
    ProcedureReturn "Number must be less than or equal to " + Str(MaxV) + " at " + Key$
  EndIf
  *outVal\i = v
  ProcedureReturn ""
EndProcedure

; invalid-args reply shape: NOT a JSON-RPC error - an isError text result:
;   MCP error -32602: Input validation error: Invalid arguments for tool
;   <name>: <issues joined "; ">
Procedure SendInvalidParams(IdValue.i, Tool$, Issues$)
  SendTextResult(IdValue, "MCP error -32602: Input validation error: Invalid arguments for tool " + Tool$ + ": " + Issues$, #True)
EndProcedure

; ---------------------------------------------------------------------------
; request dispatch
; ---------------------------------------------------------------------------
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

#MAX_JSON_DEPTH = 128

; Guard the native parser and retain numeric IDs before floating-point rounding.
Procedure.i JsonPreflight(Text$, Map NumericIds.s(), *integerOverflow.Integer)
  Protected i.i = 1, length.i = Len(Text$), c.i, start.i, real.i, limit$
  Protected depth.i, requestDepth.i, request.i, idStart.i, key$, keyPos.i
  *integerOverflow\i = #False
  While i <= length
    c = PeekU(@Text$ + (i - 1) * SizeOf(Character))
    If c = 34
      start = i
      i + 1
      While i <= length
        c = PeekU(@Text$ + (i - 1) * SizeOf(Character))
        i + 1
        If c = 92
          i + 1
        ElseIf c = 34
          Break
        EndIf
      Wend
      If depth = requestDepth
        key$ = Mid(Text$, start + 1, i - start - 2)
        If key$ = "id" Or key$ = "\u0069d" Or key$ = "i\u0064" Or key$ = "\u0069\u0064"
          keyPos = i
          While keyPos <= length And FindString(" " + Chr(9) + Chr(10) + Chr(13), Mid(Text$, keyPos, 1))
            keyPos + 1
          Wend
          If Mid(Text$, keyPos, 1) = ":"
            keyPos + 1
            While keyPos <= length And FindString(" " + Chr(9) + Chr(10) + Chr(13), Mid(Text$, keyPos, 1))
              keyPos + 1
            Wend
            idStart = keyPos
            DeleteMapElement(NumericIds(), Str(request))
          EndIf
        EndIf
      EndIf
    ElseIf c = 45 Or (c >= 48 And c <= 57)
      start = i
      limit$ = "9223372036854775807"
      If c = 45 : start + 1 : limit$ = "9223372036854775808" : EndIf
      real = #False
      i + 1
      While i <= length
        c = PeekU(@Text$ + (i - 1) * SizeOf(Character))
        If (c < 48 Or c > 57) And c <> 43 And c <> 45 And c <> 46 And c <> 69 And c <> 101 : Break : EndIf
        If c = 46 Or c = 69 Or c = 101 : real = #True : EndIf
        i + 1
      Wend
      If Not real
        ; ParseJSON wraps oversized integer literals; report after syntax validation.
        If i - start > 19 Or (i - start = 19 And Mid(Text$, start, 19) > limit$)
          *integerOverflow\i = #True
        EndIf
      EndIf
      If idStart = start Or (idStart = start - 1 And limit$ = "9223372036854775808")
        NumericIds(Str(request)) = Mid(Text$, idStart, i - idStart)
      EndIf
    Else
      If c = 123 Or c = 91
        If depth = 0 : requestDepth = 1 + Bool(c = 91) : EndIf
        depth + 1
        If depth > #MAX_JSON_DEPTH : ProcedureReturn #False : EndIf
      ElseIf c = 125 Or c = 93
        depth - 1
      ElseIf c = 44 And depth = 1 And requestDepth = 2
        request + 1
      EndIf
      i + 1
    EndIf
  Wend
  ProcedureReturn #True
EndProcedure

; Parse a validated JSON number as an exact signed integer, including .0/e forms.
Procedure.i JsonIdInteger(Token$, *number.Quad)
  If Token$ = "" : ProcedureReturn #False : EndIf
  Protected negative.i = Bool(Left(Token$, 1) = "-"), exponent$, shift.i, pos.i, limit$ = "9223372036854775807"
  If negative : Token$ = Mid(Token$, 2) : limit$ = "9223372036854775808" : EndIf
  pos = FindString(LCase(Token$), "e")
  If pos
    exponent$ = Mid(Token$, pos + 1)
    Token$ = Left(Token$, pos - 1)
  EndIf
  pos = FindString(Token$, ".")
  If pos : shift = pos - Len(Token$) : Token$ = ReplaceString(Token$, ".", "") : EndIf
  Token$ = LTrim(Token$, "0")
  If Token$ = "" : *number\q = 0 : ProcedureReturn #True : EndIf
  Protected exponentNegative.i = Bool(Left(exponent$, 1) = "-")
  If Left(exponent$, 1) = "-" Or Left(exponent$, 1) = "+" : exponent$ = Mid(exponent$, 2) : EndIf
  exponent$ = LTrim(exponent$, "0")
  ; A nonzero value cannot cancel an exponent larger than the bounded frame.
  If Len(exponent$) > Len(Str(#MAX_FRAME_BYTES)) : ProcedureReturn #False : EndIf
  If exponentNegative : shift - Val(exponent$) : Else : shift + Val(exponent$) : EndIf
  If shift < 0
    If Len(Token$) + shift < 1 Or Len(RTrim(Token$, "0")) > Len(Token$) + shift : ProcedureReturn #False : EndIf
    Token$ = Left(Token$, Len(Token$) + shift)
  ElseIf shift > 0
    If Len(Token$) + shift > 19 : ProcedureReturn #False : EndIf
    Token$ + RSet("", shift, "0")
  EndIf
  If Len(Token$) > 19 Or (Len(Token$) = 19 And Token$ > limit$) : ProcedureReturn #False : EndIf
  If negative : Token$ = "-" + Token$ : EndIf
  *number\q = Val(Token$)
  ProcedureReturn #True
EndProcedure

Procedure HandleRequest(Root.i, NumericId$)
  If JSONType(Root) <> #PB_JSON_Object
    SendError(0, -32600, "Invalid Request")
    ProcedureReturn
  EndIf
  Protected idM.i = GetJSONMember(Root, "id")
  If idM
    Select JSONType(idM)
      Case #PB_JSON_Number
        Protected idNumber.q
        If Not JsonIdInteger(NumericId$, @idNumber)
          SendError(0, -32600, "Invalid Request")
          ProcedureReturn
        EndIf
        SetJSONInteger(idM, idNumber)
      Case #PB_JSON_String
      Default
        SendError(0, -32600, "Invalid Request")
        ProcedureReturn
    EndSelect
  EndIf
  Protected methodM.i = GetJSONMember(Root, "method")
  If MemberStr(Root, "jsonrpc", "") <> "2.0" Or methodM = 0 Or JSONType(methodM) <> #PB_JSON_String
    SendError(idM, -32600, "Invalid Request")
    ProcedureReturn
  EndIf
  Protected method$ = GetJSONString(methodM)
  Protected isNotify.i = Bool(idM = 0)
  Protected params.i = GetJSONMember(Root, "params")
  If params And JSONType(params) <> #PB_JSON_Object
    If Not isNotify : SendError(idM, -32602, "params must be an object") : EndIf
    ProcedureReturn
  EndIf
  Select method$
    Case "initialize"
      If Not isNotify
        ; Version negotiation (MCP spec MUST): answer with a version the
        ; server supports - echo the client's offer only when it matches the
        ; supported version, otherwise reply with #PROTOCOL_VERSION$.
        If params = 0
          SendError(idM, -32602, "Invalid params for initialize")
          ProcedureReturn
        EndIf
        Protected pvm.i = GetJSONMember(params, "protocolVersion")
        Protected initCaps.i = GetJSONMember(params, "capabilities")
        Protected clientInfo.i = GetJSONMember(params, "clientInfo")
        If pvm = 0 Or JSONType(pvm) <> #PB_JSON_String Or initCaps = 0 Or JSONType(initCaps) <> #PB_JSON_Object Or clientInfo = 0 Or JSONType(clientInfo) <> #PB_JSON_Object
          SendError(idM, -32602, "Invalid params for initialize")
          ProcedureReturn
        EndIf
        Protected clientName.i = GetJSONMember(clientInfo, "name")
        Protected clientVersion.i = GetJSONMember(clientInfo, "version")
        If clientName = 0 Or JSONType(clientName) <> #PB_JSON_String Or clientVersion = 0 Or JSONType(clientVersion) <> #PB_JSON_String
          SendError(idM, -32602, "Invalid params for initialize")
          ProcedureReturn
        EndIf
        Protected pv$ = ActiveProtocolVersion()
        If GetJSONString(pvm) = ActiveProtocolVersion()
          pv$ = GetJSONString(pvm)
        EndIf
        Protected resp.i = BeginResponse(idM)
        Protected result.i = GetJSONMember(JSONValue(resp), "result")
        SetJSONString(AddJSONMember(result, "protocolVersion"), pv$)
        Protected caps.i = AddJSONMember(result, "capabilities")
        SetJSONObject(caps)
        Protected capsTools.i = AddJSONMember(caps, "tools")
        SetJSONObject(capsTools)
        SetJSONBoolean(AddJSONMember(capsTools, "listChanged"), #False)   ; static tool list - tools/list_changed can never fire
        ; (AddJSONMember with an existing name returns the SAME member - a
        ; second SetJSONObject on it would RESET tools to {} and drop
        ; listChanged; found live in the smoke test.)
        Protected info.i = AddJSONMember(result, "serverInfo")
        SetJSONObject(info)
        SetJSONString(AddJSONMember(info, "name"), #SERVER_NAME$)
        SetJSONString(AddJSONMember(info, "version"), ServerVersionFull())
        Protected instructions$ = "Use pb_command directly for known command names and pb_docs_search to discover names. Reuse documentation already retrieved in this session. Verify each coherent edit batch with pb_check before delivery; use pb_run for bounded noninteractive console tests."
        If gHttpMode And Not gHttpAllowCompilerTools
          instructions$ = "Search the PureBasic documentation with pb_docs_search and pb_command. This HTTP server exposes documentation tools only; compiler and execution tools are unavailable."
        EndIf
        SetJSONString(AddJSONMember(result, "instructions"), instructions$)
        FinishResponse(resp)
      EndIf
    Case "tools/list"
      If Not isNotify : ToolList(idM) : EndIf
    Case "tools/call"
      If Not isNotify : ToolDispatch(idM, params) : EndIf
    Case "ping"
      If Not isNotify
        Protected pong.i = BeginResponse(idM)
        FinishResponse(pong)
      EndIf
    Default
      ; notifications (initialized etc.) are silently ignored; unknown
      ; requests get JSON-RPC -32601
      If Not isNotify
        SendError(idM, -32601, "Method not found: " + method$)
      EndIf
  EndSelect
EndProcedure

Procedure HandleLine(Raw$)
  Protected line$ = RTrim(Trim(Raw$), Chr(13))
  If line$ = "" : ProcedureReturn : EndIf
  If JsonHasNul(line$)
    SendError(0, -32600, "NUL characters are not supported in JSON strings")
    ProcedureReturn
  EndIf
  NewMap numericIds.s()
  Protected integerOverflow.i
  If Not JsonPreflight(line$, numericIds(), @integerOverflow)
    SendError(0, -32600, "JSON nesting exceeds " + Str(#MAX_JSON_DEPTH) + " levels")
    ProcedureReturn
  EndIf
  Protected json.i = ParseJSON(#PB_Any, line$)
  If json = 0
    SendError(0, -32700, "Parse error")
    ProcedureReturn
  EndIf
  If integerOverflow
    FreeJSON(json)
    SendError(0, -32600, "JSON integer is outside the signed 64-bit range")
    ProcedureReturn
  EndIf
  Protected root.i = JSONValue(json), i.i
  If JSONType(root) = #PB_JSON_Array And JSONArraySize(root) > 0
    gBatchActive = #True
    gBatchResponses$ = ""
    For i = 0 To JSONArraySize(root) - 1
      HandleRequest(GetJSONElement(root, i), numericIds(Str(i)))
    Next
    gBatchActive = #False
    If gBatchResponses$ <> "" : WriteLine("[" + gBatchResponses$ + "]") : EndIf
    gBatchResponses$ = ""
  Else
    HandleRequest(root, numericIds("0"))
  EndIf
  FreeJSON(json)
EndProcedure
