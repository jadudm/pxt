namespace ts.yelm.ir {
    let U = ts.yelm.Util;
    let assert = U.assert;

    export enum EK {
        None,
        NumberLiteral,
        PointerLiteral,
        RuntimeCall,
        ProcCall,
        Shared,
        FieldAccess,
        Store,
        CellRef,
        Incr,
        Decr,
        Sequence,
        JmpValue,
    }

    export class Node {
        isExpr(): this is Expr { return false }
        isStmt(): this is Stmt { return false }
    }

    export class Expr extends Node {
        public jsInfo: string;
        public totalUses: number; // how many references this expression has; only for the only child of Shared
        public currUses: number;
        public isAsync: boolean;

        constructor(
            public exprKind: EK,
            public args: Expr[],
            public data: any
        ) {
            super();
        }

        isExpr() { return true }

        isStateless() {
            switch (this.exprKind) {
                case EK.NumberLiteral:
                case EK.PointerLiteral:
                    return true;
                case EK.Shared:
                    return !!this.args[0].currUses
                default: return false;
            }
        }

        canUpdateCells(): boolean {
            switch (this.exprKind) {
                case EK.NumberLiteral:
                case EK.PointerLiteral:
                case EK.CellRef:
                case EK.JmpValue:
                    return false;

                case EK.Shared:
                    if (this.isStateless()) return false;
                    return this.args[0].canUpdateCells()
                    
                case EK.Incr:
                case EK.Decr:
                case EK.FieldAccess:
                    return this.args[0].canUpdateCells()

                case EK.RuntimeCall:
                case EK.ProcCall:
                case EK.Sequence:
                    return true;

                case EK.Store:
                    return true;
                
                default: throw oops();
            }
        }
    }


    export enum SK {
        None,
        Expr,
        Label,
        Jmp,
        StackEmpty,
    }

    export enum JmpMode {
        Always = 1,
        IfZero,
        IfNotZero,
    }

    export class Stmt extends Node {
        public lblName: string;
        public lbl: Stmt;
        public lblNumUses: number;
        public jmpMode: JmpMode;

        constructor(
            public stmtKind: SK,
            public expr: Expr
        ) {
            super()
        }

        isStmt() { return true }
    }

    export class Cell {
        isarg = false;
        iscap = false;
        _isRef = false;
        _isLocal = false;
        _isGlobal = false;

        constructor(public index: number, public def: Declaration, public info: VariableAddInfo) {
            setLocationProps(this)
        }

        toString() {
            var n = ""
            if (this.def) n += (<any>this.def.name).text || "?"
            if (this.isarg) n = "ARG " + n
            if (this.isRef) n = "REF " + n
            //if (this.isByRefLocal()) n = "BYREF " + n
            return "[" + n + "]"
        }

        refSuff() {
            if (this.isRef()) return "Ref"
            else return ""
        }

        isRef() { return this._isRef }
        isLocal() { return this._isLocal }
        isGlobal() { return this._isGlobal }

        loadCore() {
            return op(EK.CellRef, null, this)
        }

        load() {
            let r = this.loadCore()
            if (this.isByRefLocal()) {
                r = rtcall("bitvm::ldloc" + this.refSuff(), [r])
            }

            if (this.isRef())
                r = op(EK.Incr, [r])

            return r
        }

        isByRefLocal() {
            return this.isLocal() && this.info.captured && this.info.written
        }

        storeDirect(src: Expr) {
            return op(EK.Store, [this.loadCore(), src])
        }

        storeByRef(src: Expr) {
            if (this.isByRefLocal()) {
                return rtcall("bitvm::stloc" + this.refSuff(), [this.loadCore(), src])
            } else {
                return this.storeDirect(src)
            }
        }
    }

    export class Procedure extends Node {
        numArgs = 0;
        info: FunctionAddInfo;
        seqNo: number;
        isRoot = false;
        locals: Cell[] = [];
        captured: Cell[] = [];
        args: Cell[] = [];
        parent: Procedure;

        body: Stmt[] = [];
        lblNo = 0;
        action: ts.FunctionLikeDeclaration;

        emit(stmt: Stmt) {
            this.body.push(stmt)
        }

        emitExpr(expr: Expr) {
            this.emit(stmt(SK.Expr, expr))
        }

        mkLabel(name: string) {
            let lbl = stmt(SK.Label, null)
            lbl.lblName = "." + name + "." + this.lblNo++
            lbl.lbl = lbl
            return lbl
        }
        emitLbl(lbl: Stmt) {
            this.emit(lbl)
        }
        emitLblDirect(lbl: string) {
            this.emit(this.mkLabel(lbl))
        }

        getName() {
            let text = this.action && this.action.name ? (<Identifier>this.action.name).text : null
            return text || "inline"
        }

        mkLocal(def: Declaration, info: VariableAddInfo) {
            var l = new Cell(this.locals.length, def, info)
            this.locals.push(l)
            return l
        }

        localIndex(l: Declaration, noargs = false): Cell {
            return this.captured.filter(n => n.def == l)[0] ||
                this.locals.filter(n => n.def == l)[0] ||
                (noargs ? null : this.args.filter(n => n.def == l)[0])
        }

        stackEmpty() {
            this.emit(stmt(SK.StackEmpty, null))
        }

        emitClrIfRef(p: Cell) {
            assert(!p.isGlobal() && !p.iscap)
            if (p.isRef() || p.isByRefLocal()) {
                this.emitExpr(op(EK.Decr, [p.loadCore()]))
            }
        }

        emitClrs() {
            if (this.isRoot) return;
            var lst = this.locals.concat(this.args)
            lst.forEach(p => this.emitClrIfRef(p))
        }

        emitJmpZ(trg: string | Stmt, expr: Expr) {
            this.emitJmp(trg, expr, JmpMode.IfZero)
        }

        emitJmp(trg: string | Stmt, expr?: Expr, mode = JmpMode.Always) {
            let jmp = stmt(SK.Jmp, expr)

            jmp.jmpMode = mode;

            if (typeof trg == "string")
                jmp.lblName = trg as any
            else {
                jmp.lbl = trg as Stmt
                jmp.lblName = jmp.lbl.lblName
            }

            this.emit(jmp)
        }

        resolve() {
            let lbls = U.toDictionary(this.body.filter(s => s.stmtKind == ir.SK.Label), s => s.lblName)
            for (let s of this.body) {
                if (s.expr)
                    iterExpr(s.expr, e => {
                        if (e.exprKind == EK.Shared) {
                            let arg = e.args[0]
                            if (!arg.totalUses) {
                                arg.totalUses = 0
                                arg.currUses = 0
                            }
                            arg.totalUses++;
                        }
                    })

                switch (s.stmtKind) {
                    case ir.SK.Expr:
                        break;
                    case ir.SK.Jmp:
                        s.lbl = U.lookup(lbls, s.lblName)
                        s.lbl.lblNumUses++
                        break;
                    case ir.SK.Label:
                        break;
                    default: oops();
                }
            }
        }
    }

    export function iterExpr(e: Expr, f: (v: Expr) => void) {
        f(e)
        if (e.args)
            for (let a of e.args)
                iterExpr(e, f)
    }

    export function stmt(kind: SK, expr: Expr): Stmt {
        return new Stmt(kind, expr)
    }

    export function op(kind: EK, args: Expr[], data?: any): Expr {
        return new Expr(kind, args, data)
    }

    export function numlit(v: number | boolean): Expr {
        return op(EK.NumberLiteral, null, v)
    }

    export function shared(expr: Expr) {
        switch (expr.exprKind) {
            case EK.NumberLiteral:
            case EK.Shared:
                return expr;
        }
        return op(EK.Shared, [expr])
    }

    export function ptrlit(lbl: string, jsInfo: string): Expr {
        let r = op(EK.PointerLiteral, null, lbl)
        r.jsInfo = jsInfo
        return r
    }

    export function rtcall(name: string, args: Expr[]) {
        return op(EK.RuntimeCall, args, name)
    }

    export function rtcallMask(name: string, mask: number, isAsync: boolean, args: Expr[]) {
        let decrs:ir.Expr[] = []
        args = args.map((a, i) => {
            if (mask & (1 << i)) {
                a = shared(a)
                decrs.push(op(EK.Decr, [a]))
                return a;
            } else return a;
        })
        let r = op(EK.RuntimeCall, args, name)
        r.isAsync = isAsync
        
        if (decrs.length > 0) {
            r = shared(r)
            decrs.unshift(r)
            decrs.push(r)
            r = op(EK.Sequence, decrs) 
        }
        
        return r
    }
}
