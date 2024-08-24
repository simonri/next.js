use anyhow::Result;
use swc_core::{
    common::{util::take::Take, DUMMY_SP},
    ecma::ast::{CallExpr, Callee, Expr, ExprOrSpread, Lit, NewExpr},
    quote_expr,
};
use turbo_tasks::{debug::ValueDebug, RcStr, Value, ValueToString, Vc};
use turbopack_core::{
    chunk::{ChunkableModuleReference, ChunkingContext, ChunkingType, ChunkingTypeOption},
    environment::ChunkLoading,
    issue::IssueSource,
    reference::ModuleReference,
    reference_type::{EcmaScriptModulesReferenceSubType, ReferenceType, UrlReferenceSubType},
    resolve::{origin::ResolveOrigin, parse::Request, url_resolve, ModuleResolveResult},
};
use turbopack_resolve::ecmascript::{esm_resolve, try_to_severity};

use super::pattern_mapping::{PatternMapping, ResolveType};
use crate::{
    code_gen::{CodeGenerateable, CodeGeneration},
    create_visitor,
    references::AstPath,
};

#[turbo_tasks::value]
#[derive(Hash, Debug)]
pub struct WorkerAssetReference {
    pub origin: Vc<Box<dyn ResolveOrigin>>,
    pub request: Vc<Request>,
    pub path: Vc<AstPath>,
    pub issue_source: Vc<IssueSource>,
    pub in_try: bool,
    pub import_externals: bool,
}

#[turbo_tasks::value_impl]
impl WorkerAssetReference {
    #[turbo_tasks::function]
    pub fn new(
        origin: Vc<Box<dyn ResolveOrigin>>,
        request: Vc<Request>,
        path: Vc<AstPath>,
        issue_source: Vc<IssueSource>,
        in_try: bool,
        import_externals: bool,
    ) -> Vc<Self> {
        Self::cell(WorkerAssetReference {
            origin,
            request,
            path,
            issue_source,
            in_try,
            import_externals,
        })
    }
}

fn worker_resolve_reference_inline(reference: &WorkerAssetReference) -> Vc<ModuleResolveResult> {
    url_resolve(
        reference.origin,
        reference.request,
        Value::new(ReferenceType::Url(UrlReferenceSubType::EcmaScriptNewUrl)),
        Some(reference.issue_source),
        try_to_severity(reference.in_try),
    )
}

#[turbo_tasks::value_impl]
impl ModuleReference for WorkerAssetReference {
    #[turbo_tasks::function]
    fn resolve_reference(&self) -> Vc<ModuleResolveResult> {
        worker_resolve_reference_inline(self)
    }
}

#[turbo_tasks::value_impl]
impl ValueToString for WorkerAssetReference {
    #[turbo_tasks::function]
    async fn to_string(&self) -> Result<Vc<RcStr>> {
        Ok(Vc::cell(
            format!("new Worker {}", self.request.to_string().await?,).into(),
        ))
    }
}

#[turbo_tasks::value_impl]
impl ChunkableModuleReference for WorkerAssetReference {
    #[turbo_tasks::function]
    fn chunking_type(&self) -> Vc<ChunkingTypeOption> {
        Vc::cell(Some(ChunkingType::Async))
    }
}

#[turbo_tasks::value_impl]
impl CodeGenerateable for WorkerAssetReference {
    #[turbo_tasks::function]
    async fn code_generation(
        &self,
        chunking_context: Vc<Box<dyn ChunkingContext>>,
    ) -> Result<Vc<CodeGeneration>> {
        // TODO change for worker
        let pm = PatternMapping::resolve_request(
            self.request,
            self.origin,
            Vc::upcast(chunking_context),
            worker_resolve_reference_inline(self),
            if matches!(
                *chunking_context.environment().chunk_loading().await?,
                ChunkLoading::Edge
            ) {
                Value::new(ResolveType::ChunkItem)
            } else {
                Value::new(ResolveType::AsyncChunkLoader)
            },
        );
        println!(
            "pm {:?} {:?} {:?} {:?}",
            self.origin.dbg().await?,
            self.request.dbg().await?,
            worker_resolve_reference_inline(self).await?,
            pm.dbg().await?,
        );

        let pm = pm.await?;

        let path = &self.path.await?;
        let import_externals = self.import_externals;

        let visitor = create_visitor!(path, visit_mut_expr(expr: &mut Expr) {
            let old_expr = expr.take();
            let message = if let Expr::New(NewExpr { args, ..}) = old_expr {
                if let Some(args) = args {
                    match args.into_iter().next() {
                        Some(ExprOrSpread { spread: None, expr: key_expr }) => {
                            *expr = pm.create_import(*key_expr, import_externals);
                            return;
                        }
                        // These are SWC bugs: https://github.com/swc-project/swc/issues/5394
                        Some(ExprOrSpread { spread: Some(_), expr: _ }) => {
                            "spread operator is illegal in new Worker() expressions."
                        }
                        _ => {
                            "new Worker() expressions require at least 1 argument"
                        }
                    }
                } else {
                    "new Worker() expressions require at least 1 argument"
                }
            } else {
                "visitor must be executed on a CallExpr"
            };
            *expr = *quote_expr!(
                "(() => { throw new Error($message); })()",
                message: Expr = Expr::Lit(Lit::Str(message.into()))
            );
        });

        Ok(CodeGeneration {
            visitors: vec![visitor],
        }
        .into())
    }
}
