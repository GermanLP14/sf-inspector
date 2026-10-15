// Análisis de conflictos de metadata basado en reglas (sin IA).
// Cada tipo de metadata tiene una lista de verificaciones. Cada verificación agrega
// "issues" a las filas afectadas: { severity, title, why, related[], fix[], note }.
//   severity "error"   → conflicto real (rojo)
//   severity "warning" → riesgo / mala práctica (ámbar)
// Una fila sin issues queda "ok" (verde).

import { API_VERSION } from "./sfapi.js";
import { L, plural, joinList } from "./i18n.js";

const PB_TYPES = new Set(["Workflow", "CustomEvent", "InvocableProcess"]);
// Momento de ejecución de los flows record-triggered.
const FLOW_PHASE = { RecordBeforeSave: "before", RecordAfterSave: "after", RecordBeforeDelete: "beforeDelete" };
const PHASE_LABEL = {
  before: L("antes de guardar", "before save"),
  after: L("después de guardar", "after save"),
  beforeDelete: L("antes de eliminar", "before delete"),
};
// [campo, etiqueta, momento equivalente de un flow]
const TRIGGER_EVENTS = [
  ["UsageBeforeInsert", "before insert", "before"],
  ["UsageAfterInsert", "after insert", "after"],
  ["UsageBeforeUpdate", "before update", "before"],
  ["UsageAfterUpdate", "after update", "after"],
  ["UsageBeforeDelete", "before delete", "beforeDelete"],
  ["UsageAfterDelete", "after delete", null],
  ["UsageAfterUndelete", "after undelete", null],
];

const ORDER_NOTE = L(
  "Orden de ejecución al guardar un registro: 1) flows antes de guardar → 2) triggers before → 3) validation rules → 4) duplicate rules → 5) triggers after → 6) assignment, auto-response y workflow rules (sus field updates vuelven a ejecutar los triggers de update) → 7) Process Builder → 8) flows después de guardar.",
  "Order of execution when a record is saved: 1) before-save flows → 2) before triggers → 3) validation rules → 4) duplicate rules → 5) after triggers → 6) assignment, auto-response and workflow rules (their field updates re-run the update triggers) → 7) Process Builder → 8) after-save flows."
);

// Nombres que una clase Apex no debería usar porque tapan clases o namespaces del sistema.
const SYSTEM_NAMES = new Set(
  [
    "System", "Schema", "Database", "Test", "Limits", "Math", "String", "Integer", "Long", "Double", "Decimal",
    "Boolean", "Date", "Datetime", "Time", "Id", "Blob", "Object", "List", "Set", "Map", "JSON", "JSONParser",
    "JSONGenerator", "Http", "HttpRequest", "HttpResponse", "Messaging", "UserInfo", "Url", "Type", "Exception",
    "Pattern", "Matcher", "Crypto", "EncodingUtil", "Site", "Network", "Approval", "Search", "Trigger", "Label",
    "Page", "ApexPages", "Auth", "Cache", "ConnectApi", "Dom", "Flow", "Process", "QuickAction", "Reports",
    "Savepoint", "Queueable", "Schedulable", "Iterable", "Iterator", "Comparable", "Callable", "SObject",
    "Address", "Location", "Version", "TimeZone", "Formula", "Assert", "EventBus", "Continuation", "Canvas",
  ].map((n) => n.toLowerCase())
);

// ───────────────────────────────────────── helpers
const lc = (s) => String(s ?? "").trim().toLowerCase();
const short = (s, n = 80) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const looksLikeId = (s) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s) && /\d/.test(s) && !s.includes("__");

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (k === null || k === undefined || k === "") continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function add(row, issue) {
  row.issues.push({ severity: "warning", related: [], fix: [], ...issue });
}

const ref = (typeKey, r, note) => ({ typeKey, name: r.name, object: r.object || null, url: r.url || null, note: note || null });

function triggerEvents(raw) {
  const known = !!raw && "UsageAfterInsert" in raw;
  const events = known ? TRIGGER_EVENTS.filter(([f]) => raw[f]) : [];
  return {
    known,
    labels: events.map((e) => e[1]),
    phases: new Set(events.map((e) => e[2]).filter(Boolean)),
  };
}

const activeRecordFlows = (flows) => flows.filter((f) => f.active && FLOW_PHASE[f.raw?.TriggerType] && f._obj);

// ───────────────────────────────────────── verificaciones reutilizables
const apiVersionCheck = {
  label: L("Versión de API con soporte", "Supported API version"),
  run(rows) {
    for (const r of rows) {
      const v = Number(r.raw?.ApiVersion);
      if (!v) continue;
      const vs = v.toFixed(1);
      if (v <= 30) {
        add(r, {
          title: L(`Versión de API ${vs} retirada`, `API version ${vs} is retired`),
          why: L(
            `El componente está guardado con la versión de API ${vs}, dentro del rango 21.0–30.0 que Salesforce retiró (Summer '25). Puede seguir ejecutándose, pero quedó sin soporte, no recibe correcciones y puede comportarse distinto que el resto del código que lo llama.`,
            `The component is saved with API version ${vs}, inside the 21.0–30.0 range Salesforce retired (Summer '25). It may still run, but it is unsupported, gets no fixes and can behave differently from the code that calls it.`
          ),
          fix: [
            L(
              `Sube la versión de API a una actual (por ejemplo ${API_VERSION}) en el archivo -meta.xml o desde Setup → Versión.`,
              `Raise the API version to a current one (e.g. ${API_VERSION}) in the -meta.xml file or in Setup → Version.`
            ),
            L(
              "Ejecuta los tests relacionados en una sandbox antes de desplegar: algunos comportamientos cambian entre versiones.",
              "Run the related tests in a sandbox before deploying: some behaviors change between versions."
            ),
          ],
        });
      } else if (v < 45) {
        add(r, {
          title: L(`Versión de API ${vs} muy antigua`, `API version ${vs} is very old`),
          why: L(
            `La versión ${vs} tiene más de siete años. No accede a funcionalidades nuevas y puede comportarse distinto que componentes en versiones recientes con los que interactúa (serialización JSON, sharing, manejo de nulos, etc.). Además es candidata a futuros retiros de versiones.`,
            `Version ${vs} is more than seven years old. It can't use newer features and may behave differently from the recent-version components it interacts with (JSON serialization, sharing, null handling, etc.). It is also a candidate for future version retirements.`
          ),
          fix: [L(`Actualiza la versión de API a ${API_VERSION} y vuelve a ejecutar los tests.`, `Update the API version to ${API_VERSION} and re-run the tests.`)],
        });
      }
    }
  },
};

const isValidCheck = {
  label: L("Compilación vigente (IsValid)", "Up-to-date compilation (IsValid)"),
  run(rows) {
    for (const r of rows) {
      if (r.raw?.IsValid !== false) continue;
      add(r, {
        title: L("Requiere recompilación: una dependencia cambió", "Needs recompiling: a dependency changed"),
        why: L(
          "Salesforce marca este componente como inválido (IsValid = false) porque algo de lo que depende —otra clase, un campo, un objeto— cambió después de su última compilación. Se intenta recompilar al ejecutarse; si la dependencia ya no es compatible, fallará en tiempo de ejecución.",
          "Salesforce flags this component as invalid (IsValid = false) because something it depends on —another class, a field, an object— changed after it was last compiled. It is recompiled on execution; if the dependency is no longer compatible, it will fail at runtime."
        ),
        fix: [
          L("En Setup → Apex Classes usa «Compile all classes», o vuelve a guardar el componente.", "In Setup → Apex Classes use “Compile all classes”, or save the component again."),
          L(
            "Si la compilación falla, el error indica qué dependencia cambió: ajusta el código o restaura la dependencia.",
            "If compilation fails, the error tells you which dependency changed: adjust the code or restore the dependency."
          ),
        ],
      });
    }
  },
};

/** Labels / valores repetidos dentro de un alcance (objeto, carpeta u org). */
function dupCheck({
  label = L("Nombres y labels únicos", "Unique names and labels"),
  value = (r) => r.label || r.name,
  scope = (r) => r.object || "",
  what = L("label", "label"),
  activeOnly = false,
  why,
  fix,
} = {}) {
  return {
    label,
    run(rows, ctx) {
      const candidates = rows.filter((r) => (!activeOnly || r.active !== false) && lc(value(r)));
      for (const group of groupBy(candidates, (r) => `${lc(scope(r))}|${lc(value(r))}`).values()) {
        if (group.length < 2) continue;
        for (const r of group) {
          const others = group.filter((o) => o !== r);
          const v = short(value(r));
          const where = scope(r) ? L(` en ${scope(r)}`, ` in ${scope(r)}`) : L(" en la org", " in the org");
          add(r, {
            title: L(`${what[0].toUpperCase() + what.slice(1)} duplicado`, `Duplicate ${what}`),
            why: why
              ? why(r, others, v, where)
              : L(
                  `Hay ${group.length} ${ctx.typeLabel} con el mismo ${what} «${v}»${where}. En listas, selectores, reportes y asignaciones no se distinguen entre sí, y es fácil usar o modificar el equivocado.`,
                  `There are ${group.length} ${ctx.typeLabel} with the same ${what} “${v}”${where}. They can't be told apart in lists, pickers, reports and assignments, so it's easy to use or edit the wrong one.`
                ),
            related: others.map((o) => ref(ctx.typeKey, o)),
            fix: fix || [
              L(`Renombra el ${what} para que sea único y describa su propósito.`, `Rename the ${what} so it is unique and describes its purpose.`),
              L("Si realmente hacen lo mismo, consolida en uno solo y elimina o desactiva el resto.", "If they really do the same thing, consolidate into one and delete or deactivate the rest."),
            ],
          });
        }
      }
    },
  };
}

// ───────────────────────────────────────── reglas por tipo
const triggerOverlap = {
  label: L("Un solo trigger activo por objeto y evento", "One active trigger per object and event"),
  run(rows) {
    const active = rows.filter((r) => r.active && r.object);
    for (const group of groupBy(active, (r) => lc(r.object)).values()) {
      if (group.length < 2) continue;
      for (const t of group) {
        const ev = triggerEvents(t.raw);
        const clashes = group
          .filter((o) => o !== t)
          .map((o) => {
            const oe = triggerEvents(o.raw);
            const shared = ev.known && oe.known ? ev.labels.filter((l) => oe.labels.includes(l)) : null;
            return { o, shared };
          })
          .filter((c) => c.shared === null || c.shared.length);
        if (!clashes.length) continue;
        const sharedAll = [...new Set(clashes.flatMap((c) => c.shared || []))];
        const events = sharedAll.join(", ");
        add(t, {
          severity: "error",
          title: L(
            `Comparte eventos con ${plural(clashes.length, ["otro trigger", "otros triggers"], ["", ""])} de ${t.object}`,
            `Shares events with ${plural(clashes.length, ["", ""], ["other trigger", "other triggers"])} on ${t.object}`
          ),
          why: L(
            `${t.object} tiene ${group.length} triggers activos que se ejecutan en ${sharedAll.length ? `los mismos eventos (${events})` : "el mismo objeto"}. Salesforce no garantiza en qué orden se ejecutan varios triggers del mismo objeto y evento: el resultado puede variar entre ejecuciones, uno puede pisar los cambios del otro y se multiplican las consultas y DML, acercándose a los límites de gobierno.`,
            `${t.object} has ${group.length} active triggers running on ${sharedAll.length ? `the same events (${events})` : "the same object"}. Salesforce does not guarantee the order in which several triggers of the same object and event run: results can vary between executions, one can overwrite the other's changes, and queries and DML multiply, getting closer to governor limits.`
          ),
          related: clashes.map((c) => ref("ApexTrigger", c.o, c.shared ? c.shared.join(", ") : null)),
          fix: [
            L(
              `Unifica la lógica en un único trigger para ${t.object} que delegue en una clase handler (patrón «un trigger por objeto»).`,
              `Merge the logic into a single trigger for ${t.object} that delegates to a handler class (“one trigger per object” pattern).`
            ),
            L("Mueve la lógica del trigger legado al handler y luego desactívalo o elimínalo.", "Move the legacy trigger's logic into the handler, then deactivate or delete it."),
            L("Agrega tests que validen el orden y el resultado esperado de cada paso.", "Add tests that validate the order and the expected result of each step."),
          ],
        });
      }
    }
  },
};

const triggerVsAutomation = {
  label: L("Convivencia con flows y Workflow Rules del mismo objeto", "Coexistence with flows and Workflow Rules on the same object"),
  async run(rows, ctx) {
    const flows = await ctx.flows();
    const wfr = await ctx.optionalRows("WorkflowRule");
    const rt = activeRecordFlows(flows);
    for (const t of rows.filter((r) => r.active && r.object)) {
      const ev = triggerEvents(t.raw);
      const obj = lc(t.object);
      const sameFlows = rt.filter((f) => lc(f._obj) === obj && (!ev.known || ev.phases.has(FLOW_PHASE[f.raw.TriggerType])));
      const updates = !ev.known || ev.labels.some((l) => l.endsWith("update"));
      const sameWfr = updates ? wfr.filter((w) => lc(w.object) === obj) : [];
      if (!sameFlows.length && !sameWfr.length) continue;
      const parts = [];
      if (sameFlows.length)
        parts.push(
          plural(sameFlows.length, ["flow record-triggered activo", "flows record-triggered activos"], ["active record-triggered flow", "active record-triggered flows"]) +
            L(" en el mismo momento", " at the same moment")
        );
      if (sameWfr.length) parts.push(plural(sameWfr.length, ["Workflow Rule", "Workflow Rules"], ["Workflow Rule", "Workflow Rules"]));
      add(t, {
        title: L(`Convive con otras automatizaciones en ${t.object}`, `Coexists with other automations on ${t.object}`),
        why:
          L(
            `Además de este trigger, ${t.object} tiene ${joinList(parts)}. Si varias automatizaciones actualizan los mismos campos o hacen DML sobre los mismos registros, pueden pisarse valores, duplicar trabajo o provocar recursión.`,
            `Besides this trigger, ${t.object} has ${joinList(parts)}. If several automations update the same fields or run DML on the same records, they can overwrite values, duplicate work or cause recursion.`
          ) +
          (sameWfr.length
            ? L(" Los field updates de las Workflow Rules vuelven a ejecutar los triggers de update una vez más.", " Workflow Rule field updates run the update triggers one more time.")
            : ""),
        note: ORDER_NOTE,
        related: [
          ...sameFlows.map((f) => ref("Flow", f, PHASE_LABEL[FLOW_PHASE[f.raw.TriggerType]])),
          ...sameWfr.map((w) => ref("WorkflowRule", w)),
        ],
        fix: [
          L(
            `Revisa todas las automatizaciones de ${t.object} en Setup → Flow Trigger Explorer y verifica qué campos modifica cada una.`,
            `Review every automation on ${t.object} in Setup → Flow Trigger Explorer and check which fields each one changes.`
          ),
          L(
            "Si dos automatizaciones tocan los mismos campos, centraliza esa lógica en un solo lugar (el trigger handler o un único flow).",
            "If two automations touch the same fields, centralize that logic in one place (the trigger handler or a single flow)."
          ),
          ...(sameWfr.length
            ? [
                L(
                  "Migra las Workflow Rules a Flow y asegúrate de que el trigger sea idempotente (que ejecutarse dos veces no duplique efectos).",
                  "Migrate the Workflow Rules to Flow and make sure the trigger is idempotent (running twice must not duplicate effects)."
                ),
              ]
            : []),
        ],
      });
    }
  },
};

const flowOrder = {
  label: L("Orden de ejecución definido entre flows del mismo objeto", "Defined execution order between flows on the same object"),
  run(rows) {
    const rt = activeRecordFlows(rows);
    for (const group of groupBy(rt, (f) => `${lc(f._obj)}|${f.raw.TriggerType}`).values()) {
      if (group.length < 2) continue;
      const orderReadable = group.some((f) => "TriggerOrder" in f.raw);
      const phase = PHASE_LABEL[FLOW_PHASE[group[0].raw.TriggerType]];
      for (const f of group) {
        const others = group.filter((o) => o !== f);
        const order = f.raw.TriggerOrder;
        if (order !== null && order !== undefined) {
          const same = others.filter((o) => o.raw.TriggerOrder === order);
          if (!same.length) continue;
          add(f, {
            title: L(`Trigger Order ${order} repetido`, `Trigger Order ${order} is repeated`),
            why: L(
              `${same.length + 1} flows que se ejecutan ${phase} sobre ${f._obj} tienen el mismo Trigger Order (${order}). Salesforce los desempata de forma implícita (por nombre), así que renombrar o crear un flow puede cambiar el orden sin que nadie lo note.`,
              `${same.length + 1} flows that run ${phase} on ${f._obj} share the same Trigger Order (${order}). Salesforce breaks the tie implicitly (by name), so renaming or creating a flow can change the order without anyone noticing.`
            ),
            related: same.map((o) => ref("Flow", o, `Trigger Order ${order}`)),
            fix: [
              L(
                "Asigna un Trigger Order distinto a cada flow desde Setup → Flow Trigger Explorer o en las propiedades del flow.",
                "Give each flow a different Trigger Order from Setup → Flow Trigger Explorer or in the flow properties."
              ),
            ],
          });
        } else {
          add(f, {
            title: L(
              `Orden sin definir frente a ${plural(others.length, ["otro flow", "otros flows"], ["", ""])}`,
              `Undefined order versus ${plural(others.length, ["", ""], ["other flow", "other flows"])}`
            ),
            why:
              L(
                `Hay ${group.length} flows activos que se ejecutan ${phase} sobre ${f._obj} y este no tiene Trigger Order. Los flows sin orden se ejecutan después de los que sí lo tienen y en un orden implícito, así que si actualizan los mismos campos el resultado final puede no ser el esperado.`,
                `There are ${group.length} active flows running ${phase} on ${f._obj} and this one has no Trigger Order. Flows without an order run after the ones that have it, in an implicit order, so if they update the same fields the final result may not be what you expect.`
              ) +
              (orderReadable
                ? ""
                : L(
                    " (No se pudo leer el campo Trigger Order en esta org: confirma el valor en Flow Trigger Explorer.)",
                    " (The Trigger Order field could not be read in this org: confirm the value in Flow Trigger Explorer.)"
                  )),
            related: others.map((o) => ref("Flow", o, o.raw.TriggerOrder != null ? `Trigger Order ${o.raw.TriggerOrder}` : L("sin orden", "no order"))),
            fix: [
              L("Define el Trigger Order (1–2000) de cada flow desde Setup → Flow Trigger Explorer.", "Set the Trigger Order (1–2000) of each flow from Setup → Flow Trigger Explorer."),
              L(
                `Considera consolidarlos en un único flow ${phase} para ${f._obj} con elementos de decisión.`,
                `Consider consolidating them into a single ${phase} flow for ${f._obj} using decision elements.`
              ),
            ],
          });
        }
      }
    }
  },
};

const flowVsTriggers = {
  label: L("Convivencia con triggers de Apex del mismo objeto", "Coexistence with Apex triggers on the same object"),
  async run(rows, ctx) {
    const triggers = (await ctx.rows("ApexTrigger")).filter((t) => t.active && t.object);
    for (const f of activeRecordFlows(rows)) {
      const phase = FLOW_PHASE[f.raw.TriggerType];
      const same = triggers.filter((t) => {
        if (lc(t.object) !== lc(f._obj)) return false;
        const ev = triggerEvents(t.raw);
        return !ev.known || ev.phases.has(phase);
      });
      if (!same.length) continue;
      add(f, {
        title: L(
          `Comparte ${f._obj} con ${plural(same.length, ["trigger de Apex", "triggers de Apex"], ["", ""])}`,
          `Shares ${f._obj} with ${plural(same.length, ["", ""], ["Apex trigger", "Apex triggers"])}`
        ),
        why: L(
          `Este flow se ejecuta ${PHASE_LABEL[phase]} sobre ${f._obj}, y en ese mismo momento también corren triggers de Apex. Si ambos modifican los mismos campos o registros relacionados, el último en ejecutarse gana y los errores son difíciles de rastrear.`,
          `This flow runs ${PHASE_LABEL[phase]} on ${f._obj}, and Apex triggers also run at that same moment. If both change the same fields or related records, the last one to run wins and bugs are hard to trace.`
        ),
        note: ORDER_NOTE,
        related: same.map((t) => ref("ApexTrigger", t, triggerEvents(t.raw).labels.join(", ") || null)),
        fix: [
          L("Verifica que el flow y el trigger no actualicen los mismos campos.", "Check that the flow and the trigger don't update the same fields."),
          L(
            `Define un dueño claro de la lógica de ${f._obj}: o todo en el trigger handler o todo en flows.`,
            `Define a clear owner for ${f._obj} logic: either everything in the trigger handler or everything in flows.`
          ),
        ],
      });
    }
  },
};

const processBuilderRetired = {
  label: L("Process Builder sin soporte", "Unsupported Process Builder"),
  run(rows) {
    for (const f of rows) {
      if (!f.active || !PB_TYPES.has(f.raw?.ProcessType)) continue;
      add(f, {
        title: L("Process Builder sin soporte", "Process Builder is no longer supported"),
        why: L(
          "Salesforce terminó el soporte de Process Builder el 31 de diciembre de 2025: sigue ejecutándose, pero no recibe correcciones ni mejoras. Además corre en un punto distinto del orden de ejecución que los flows, lo que complica entender qué automatización modificó un registro.",
          "Salesforce ended support for Process Builder on December 31, 2025: it still runs, but gets no fixes or improvements. It also runs at a different point of the order of execution than flows, which makes it harder to know which automation changed a record."
        ),
        note: ORDER_NOTE,
        fix: [
          L("Usa Setup → Migrate to Flow para convertir el proceso en un flow record-triggered.", "Use Setup → Migrate to Flow to convert the process into a record-triggered flow."),
          L("Prueba el flow nuevo en una sandbox, actívalo y desactiva el proceso original.", "Test the new flow in a sandbox, activate it and deactivate the original process."),
        ],
      });
    }
  },
};

const flowPendingVersion = {
  label: L("Versión activa coincide con la última", "Active version matches the latest"),
  run(rows) {
    for (const f of rows) {
      const { ActiveVersionId: a, LatestVersionId: l } = f.raw || {};
      if (!f.active || !a || !l || a === l) continue;
      add(f, {
        title: L("Hay una versión más nueva sin activar", "A newer version is not activated"),
        why: L(
          "La versión activa del flow no es la última guardada. O hay cambios pendientes que todavía no se activaron, o alguien reactivó una versión anterior. En ambos casos lo que se ejecuta no es lo que se ve al abrir la última versión.",
          "The active version of the flow is not the latest saved one. Either there are pending changes that were never activated, or someone reactivated an older version. Either way, what runs is not what you see when you open the latest version."
        ),
        fix: [
          L("Abre el flow, compara la versión activa con la última y activa la correcta.", "Open the flow, compare the active version with the latest one and activate the right one."),
          L(
            "Elimina las versiones obsoletas para evitar confusiones (Salesforce permite hasta 50 versiones por flow).",
            "Delete obsolete versions to avoid confusion (Salesforce allows up to 50 versions per flow)."
          ),
        ],
      });
    }
  },
};

const workflowRetired = {
  label: L("Workflow Rules sin soporte", "Unsupported Workflow Rules"),
  run(rows) {
    for (const w of rows) {
      add(w, {
        title: L("Workflow Rule sin soporte", "Workflow Rule is no longer supported"),
        why: L(
          "Salesforce terminó el soporte de Workflow Rules el 31 de diciembre de 2025. Si la regla está activa sigue ejecutándose, pero no recibe correcciones, y sus field updates vuelven a disparar los triggers de update, lo que suele causar efectos duplicados.",
          "Salesforce ended support for Workflow Rules on December 31, 2025. If the rule is active it still runs, but gets no fixes, and its field updates re-fire the update triggers, which often causes duplicated effects."
        ),
        note: ORDER_NOTE,
        fix: [
          L("Migra la regla con Setup → Migrate to Flow.", "Migrate the rule with Setup → Migrate to Flow."),
          L("Si está inactiva y ya no se usa, elimínala para reducir ruido.", "If it is inactive and no longer used, delete it to reduce noise."),
        ],
      });
    }
  },
};

const workflowRefire = {
  label: L("Re-ejecución de triggers y flows por field updates", "Triggers and flows re-run by field updates"),
  async run(rows, ctx) {
    const triggers = (await ctx.optionalRows("ApexTrigger")).filter((t) => {
      const ev = triggerEvents(t.raw);
      return t.active && t.object && (!ev.known || ev.labels.some((l) => l.endsWith("update")));
    });
    const flows = activeRecordFlows(await ctx.flows()).filter((f) => f.raw.TriggerType !== "RecordBeforeDelete");
    for (const w of rows.filter((r) => r.object)) {
      const tr = triggers.filter((t) => lc(t.object) === lc(w.object));
      const fl = flows.filter((f) => lc(f._obj) === lc(w.object));
      if (!tr.length && !fl.length) continue;
      const what = joinList(
        [
          tr.length && plural(tr.length, ["trigger de update", "triggers de update"], ["update trigger", "update triggers"]),
          fl.length && plural(fl.length, ["flow record-triggered", "flows record-triggered"], ["record-triggered flow", "record-triggered flows"]),
        ].filter(Boolean)
      );
      add(w, {
        title: L(`Puede re-ejecutar automatizaciones de ${w.object}`, `May re-run automations on ${w.object}`),
        why: L(
          `Si esta regla tiene field updates, al ejecutarse vuelve a disparar ${what} de ${w.object}. Eso duplica cálculos, callouts o registros creados si esas automatizaciones no son idempotentes.`,
          `If this rule has field updates, running it fires ${what} on ${w.object} again. That duplicates calculations, callouts or created records if those automations are not idempotent.`
        ),
        note: ORDER_NOTE,
        related: [...tr.map((t) => ref("ApexTrigger", t)), ...fl.map((f) => ref("Flow", f))],
        fix: [
          L("Migra la lógica de la Workflow Rule a un flow before-save (no re-ejecuta triggers).", "Move the Workflow Rule logic into a before-save flow (it does not re-run triggers)."),
          L("Mientras tanto, protege los triggers con controles de recursión.", "Meanwhile, protect the triggers with recursion guards."),
        ],
      });
    }
  },
};

const classShadowing = {
  label: L("Nombre de clase no choca con clases del sistema ni objetos estándar", "Class name doesn't clash with system classes or standard objects"),
  async run(rows, ctx) {
    const s = await ctx.sobjects();
    for (const r of rows) {
      if (r.namespace) continue;
      const n = lc(r.name);
      if (SYSTEM_NAMES.has(n)) {
        add(r, {
          severity: "error",
          title: L(`Choca con la clase del sistema «${r.name}»`, `Clashes with the system class “${r.name}”`),
          why: L(
            `Existe una clase o namespace estándar de Apex llamado ${r.name}. Una clase propia con el mismo nombre tiene prioridad en la resolución de nombres, por lo que el código que espera la clase del sistema (por ejemplo ${r.name}.algunMetodo()) termina usando esta, provocando errores como «Method does not exist» o comportamientos inesperados en código nuevo y paquetes.`,
            `There is a standard Apex class or namespace called ${r.name}. A custom class with the same name wins name resolution, so code expecting the system class (e.g. ${r.name}.someMethod()) ends up using this one, causing errors like “Method does not exist” or unexpected behavior in new code and packages.`
          ),
          fix: [
            L(`Renombra la clase (por ejemplo ${r.name}Util o ${r.name}Service) y actualiza sus referencias.`, `Rename the class (e.g. ${r.name}Util or ${r.name}Service) and update its references.`),
            L("Despliega el cambio de nombre junto con todas las clases que la referencian.", "Deploy the rename together with every class that references it."),
          ],
        });
      } else if (s.standard.has(n)) {
        const obj = s.byName.get(n);
        add(r, {
          title: L(`Choca con el objeto estándar «${obj}»`, `Clashes with the standard object “${obj}”`),
          why: L(
            `La clase se llama igual que el objeto estándar ${obj}. En Apex, las referencias a ${r.name} pueden resolverse a esta clase en lugar del sObject, generando errores de compilación confusos («Invalid type», campos inexistentes) cuando alguien escribe código sobre ese objeto.`,
            `The class has the same name as the standard object ${obj}. In Apex, references to ${r.name} may resolve to this class instead of the sObject, producing confusing compile errors (“Invalid type”, missing fields) when someone writes code for that object.`
          ),
          fix: [L(`Renombra la clase con un sufijo descriptivo (por ejemplo ${r.name}Service o ${r.name}Helper).`, `Rename the class with a descriptive suffix (e.g. ${r.name}Service or ${r.name}Helper).`)],
        });
      }
    }
  },
};

const objectFieldCount = {
  label: L("Cantidad de campos custom por objeto", "Custom fields per object"),
  async run(rows, ctx) {
    const fields = await ctx.rows("CustomField");
    const counts = new Map();
    for (const f of fields) if (f.object) counts.set(lc(f.object), (counts.get(lc(f.object)) || 0) + 1);
    for (const o of rows) {
      const n = counts.get(lc(o.name)) || 0;
      if (n < 400) continue;
      add(o, {
        severity: n >= 500 ? "error" : "warning",
        title: L(`${n} campos custom: cerca del límite`, `${n} custom fields: close to the limit`),
        why: L(
          `${o.name} tiene ${n} campos custom. El límite es 500 en Enterprise Edition y 800 en Unlimited/Performance (los campos eliminados también cuentan hasta que se borran definitivamente). Al alcanzarlo no se pueden crear campos nuevos y los despliegues que agreguen campos fallan.`,
          `${o.name} has ${n} custom fields. The limit is 500 in Enterprise Edition and 800 in Unlimited/Performance (deleted fields also count until they are erased permanently). Once reached, no new fields can be created and deployments adding fields fail.`
        ),
        fix: [
          L(
            "Identifica campos sin uso (sin datos, sin referencias) y elimínalos definitivamente desde la papelera de campos.",
            "Find unused fields (no data, no references) and erase them permanently from the deleted fields list."
          ),
          L("Agrupa información poco consultada en objetos relacionados.", "Move rarely used information into related objects."),
        ],
      });
    }
  },
};

const fieldNamespaceDup = {
  label: L("Sin campos homónimos entre namespaces", "No same-name fields across namespaces"),
  run(rows) {
    for (const group of groupBy(rows.filter((r) => r.object && r.raw?.DeveloperName), (r) => `${lc(r.object)}|${lc(r.raw.DeveloperName)}`).values()) {
      if (group.length < 2) continue;
      for (const f of group) {
        const others = group.filter((o) => o !== f);
        const names = group.map((g) => g.name).join(", ");
        add(f, {
          title: L("Campo homónimo en otro namespace", "Same-name field in another namespace"),
          why: L(
            `En ${f.object} existen ${group.length} campos con el nombre base «${f.raw.DeveloperName}» (${names}), normalmente uno propio y otro de un paquete. Es fácil referenciar el equivocado en fórmulas, reportes, flows o Apex.`,
            `${f.object} has ${group.length} fields with the base name “${f.raw.DeveloperName}” (${names}), usually one of yours and one from a package. It's easy to reference the wrong one in formulas, reports, flows or Apex.`
          ),
          related: others.map((o) => ref("CustomField", o)),
          fix: [
            L("Verifica cuál de los dos se usa realmente y deja de usar el otro.", "Check which one is actually used and stop using the other."),
            L("Cambia el label del campo propio para que no se confunda con el del paquete.", "Change your field's label so it can't be confused with the package one."),
          ],
        });
      }
    }
  },
};

const approvalOverlap = {
  label: L("Procesos de aprobación activos por objeto", "Active approval processes per object"),
  run(rows) {
    for (const group of groupBy(rows.filter((r) => r.active && r.object), (r) => lc(r.object)).values()) {
      if (group.length < 2) continue;
      for (const a of group) {
        add(a, {
          title: L(`${group.length} procesos de aprobación activos en ${a.object}`, `${group.length} active approval processes on ${a.object}`),
          why: L(
            `Cuando un registro de ${a.object} se envía a aprobación, Salesforce evalúa los procesos activos en orden y usa solo el primero cuyos criterios de entrada se cumplen. Si los criterios se superponen, los procesos posteriores nunca se ejecutan.`,
            `When a ${a.object} record is submitted for approval, Salesforce evaluates the active processes in order and only uses the first one whose entry criteria match. If criteria overlap, later processes never run.`
          ),
          related: group.filter((o) => o !== a).map((o) => ref("ApprovalProcess", o)),
          fix: [
            L(
              "Revisa el orden de los procesos en Setup → Approval Processes y que los criterios de entrada sean excluyentes.",
              "Review the process order in Setup → Approval Processes and make the entry criteria mutually exclusive."
            ),
            L("Desactiva los procesos que ya no se usan.", "Deactivate processes that are no longer used."),
          ],
        });
      }
    }
  },
};

const permSetGroupStatus = {
  label: L("Estado de cálculo del grupo", "Group calculation status"),
  run(rows) {
    for (const r of rows) {
      const st = r.raw?.Status;
      if (st === "Failed") {
        add(r, {
          severity: "error",
          title: L("El recálculo del grupo falló", "Group recalculation failed"),
          why: L(
            "Salesforce no pudo calcular los permisos agregados del grupo. Los usuarios asignados pueden no estar recibiendo los permisos esperados.",
            "Salesforce couldn't calculate the group's aggregated permissions. Assigned users may not be getting the expected permissions."
          ),
          fix: [
            L("Abre el grupo en Setup y revisa los permission sets incluidos y los muted permissions.", "Open the group in Setup and review the included permission sets and muted permissions."),
            L(
              "Vuelve a lanzar el recálculo; si persiste, quita y vuelve a agregar el permission set que lo provoca.",
              "Run the recalculation again; if it persists, remove and re-add the permission set causing it."
            ),
          ],
        });
      } else if (st === "Outdated") {
        add(r, {
          title: L("Grupo desactualizado", "Group is outdated"),
          why: L(
            "Alguno de los permission sets del grupo cambió y el grupo todavía no se recalculó: los usuarios tienen la versión anterior de los permisos.",
            "One of the group's permission sets changed and the group hasn't been recalculated yet: users still have the previous permissions."
          ),
          fix: [L("Abre el grupo en Setup → Permission Set Groups y recalcúlalo.", "Open the group in Setup → Permission Set Groups and recalculate it.")],
        });
      }
    }
  },
};

const staticResourceSize = {
  label: L("Tamaño dentro del límite", "Size within the limit"),
  run(rows) {
    for (const r of rows) {
      const b = r.raw?.BodyLength || 0;
      if (b < 4.5 * 1024 * 1024) continue;
      const mb = (b / 1024 / 1024).toFixed(1);
      add(r, {
        title: L(`${mb} MB: cerca del límite de 5 MB`, `${mb} MB: close to the 5 MB limit`),
        why: L(
          "Cada static resource puede pesar como máximo 5 MB. Uno tan grande además ralentiza la carga de las páginas que lo usan.",
          "Each static resource can be at most 5 MB. One this large also slows down the pages that use it."
        ),
        fix: [
          L("Divide el recurso en varios archivos o mueve los assets pesados a otro almacenamiento.", "Split the resource into several files or move heavy assets to other storage."),
          L("Minifica JS/CSS y comprime imágenes.", "Minify JS/CSS and compress images."),
        ],
      });
    }
  },
};

const agentActionTarget = {
  label: L("La acción apunta a un Apex, flow o prompt existente", "Action points to an existing Apex, flow or prompt"),
  async run(rows, ctx) {
    const kinds = {
      apex: { key: "ApexClass", label: L("la clase Apex", "the Apex class") },
      flow: { key: "Flow", label: L("el flow", "the flow") },
      prompt: { key: "GenAiPromptTemplate", label: L("el prompt template", "the prompt template") },
      generatepromptresponse: { key: "GenAiPromptTemplate", label: L("el prompt template", "the prompt template") },
    };
    const cache = {};
    for (const a of rows) {
      const type = lc(a.raw?.InvocationTargetType);
      const target = a.raw?.InvocationTarget;
      const kind = kinds[type];
      if (!kind || !target || looksLikeId(target)) continue;
      cache[kind.key] ||= await ctx.optionalRows(kind.key);
      const list = cache[kind.key];
      if (!list.length) continue; // sin acceso: no podemos afirmar nada
      const match = list.find((x) => lc(x.name) === lc(target));
      if (!match) {
        add(a, {
          severity: "error",
          title: L(`Apunta a ${kind.label} «${target}», que no existe`, `Points to ${kind.label} “${target}”, which doesn't exist`),
          why: L(
            `La acción invoca ${kind.label} «${target}», pero no aparece en la org (o tu usuario no puede verlo). Cuando el agente intente usar esta acción, fallará y el usuario recibirá un error.`,
            `The action invokes ${kind.label} “${target}”, but it isn't in the org (or your user can't see it). When the agent tries to use this action it will fail and the user will get an error.`
          ),
          fix: [
            L("Verifica si el componente fue renombrado o eliminado y actualiza la acción en Agentforce Builder.", "Check whether the component was renamed or deleted and update the action in Agentforce Builder."),
            L("Si se eliminó a propósito, quita la acción de los topics que la usan.", "If it was deleted on purpose, remove the action from the topics that use it."),
          ],
        });
      } else if (kind.key === "Flow" && match.active === false) {
        add(a, {
          title: L(`El flow «${target}» está inactivo`, `Flow “${target}” is inactive`),
          why: L(
            "La acción invoca un flow que no tiene una versión activa. El agente no podrá ejecutarla hasta que se active.",
            "The action invokes a flow with no active version. The agent won't be able to run it until it's activated."
          ),
          related: [ref("Flow", match)],
          fix: [L("Activa el flow o cambia la acción para que use otro activo.", "Activate the flow or change the action to use an active one.")],
        });
      }
    }
  },
};

// ───────────────────────────────────────── catálogo
const ANALYZERS = {
  ApexClass: { checks: [classShadowing, isValidCheck, apiVersionCheck] },
  ApexTrigger: { checks: [triggerOverlap, triggerVsAutomation, isValidCheck, apiVersionCheck] },
  LightningComponentBundle: { checks: [apiVersionCheck] },
  AuraDefinitionBundle: { checks: [apiVersionCheck] },
  ApexPage: { checks: [apiVersionCheck] },
  ApexComponent: { checks: [apiVersionCheck] },
  StaticResource: { checks: [staticResourceSize] },
  Flow: { checks: [flowOrder, flowVsTriggers, processBuilderRetired, flowPendingVersion], dup: { scope: () => "" } },
  WorkflowRule: { checks: [workflowRetired, workflowRefire] },
  ApprovalProcess: { checks: [approvalOverlap] },
  BotDefinition: { dup: { scope: () => "" } },
  GenAiPlugin: { dup: { scope: () => "" } },
  GenAiFunction: { checks: [agentActionTarget], dup: { scope: () => "" } },
  GenAiPromptTemplate: { dup: { scope: () => "" } },
  CustomObject: { checks: [objectFieldCount], dup: { scope: () => "" } },
  CustomField: { checks: [fieldNamespaceDup], dup: false },
  CustomMetadataType: { dup: { scope: () => "" } },
  CustomMetadataRecord: {},
  ValidationRule: {
    dup: {
      label: L("Sin reglas duplicadas en el mismo objeto", "No duplicate rules on the same object"),
      value: (r) => r.raw?.ErrorMessage,
      what: L("mensaje de error", "error message"),
      activeOnly: true,
      why: (r, others, v, where) =>
        L(
          `Hay ${others.length + 1} validation rules activas con el mismo mensaje «${v}»${where}. Suele indicar lógica duplicada: al modificar una se olvida la otra, y el usuario ve el mismo error sin saber cuál regla lo provocó.`,
          `There are ${others.length + 1} active validation rules with the same message “${v}”${where}. This usually means duplicated logic: someone edits one and forgets the other, and users see the same error without knowing which rule raised it.`
        ),
      fix: [
        L("Compara las fórmulas de ambas reglas y unifícalas en una sola.", "Compare both rules' formulas and merge them into one."),
        L("Si validan cosas distintas, usa mensajes que expliquen cada caso.", "If they validate different things, use messages that explain each case."),
      ],
    },
  },
  CustomLabel: {
    dup: {
      value: (r) => r.label,
      scope: (r) => (r.raw?.Language ? L(`idioma ${r.raw.Language}`, `language ${r.raw.Language}`) : ""),
      what: L("valor", "value"),
      why: (r, others, v) =>
        L(
          `Hay ${others.length + 1} custom labels con el mismo texto «${v}». Mantener copias hace que al corregir o traducir uno se olvide el otro.`,
          `There are ${others.length + 1} custom labels with the same text “${v}”. Keeping copies means that when one is fixed or translated, the other is forgotten.`
        ),
      fix: [
        L("Reutiliza un único custom label y reemplaza las referencias al duplicado.", "Reuse a single custom label and replace references to the duplicate."),
        L("Elimina el label que quede sin uso.", "Delete the label that ends up unused."),
      ],
    },
  },
  NamedCredential: {
    dup: {
      what: "endpoint",
      scope: () => "",
      why: (r, others, v) =>
        L(
          `Hay ${others.length + 1} named credentials que apuntan al mismo endpoint «${v}». Las credenciales y la configuración de autenticación pueden divergir y cada integración termina usando una distinta.`,
          `There are ${others.length + 1} named credentials pointing to the same endpoint “${v}”. Credentials and authentication settings can drift apart and each integration ends up using a different one.`
        ),
      fix: [
        L("Unifica las integraciones para usar una sola named credential.", "Make every integration use a single named credential."),
        L("Elimina la que quede sin referencias.", "Delete the one left without references."),
      ],
    },
  },
  Report: { dup: { value: (r) => r.name, scope: (r) => (r.category ? L(`la carpeta «${r.category}»`, `folder “${r.category}”`) : ""), what: L("nombre", "name") } },
  Dashboard: { dup: { value: (r) => r.name, scope: (r) => (r.category ? L(`la carpeta «${r.category}»`, `folder “${r.category}”`) : ""), what: L("nombre", "name") } },
  PermissionSetGroup: { checks: [permSetGroupStatus], dup: { scope: () => "" } },
  PermissionSet: { dup: { scope: () => "" } },
  CustomPermission: { dup: { scope: () => "" } },
  GlobalValueSet: { dup: { scope: () => "" } },
  EmailTemplate: { dup: { scope: () => "" } },
  FlexiPage: { dup: { scope: (r) => [r.object, r.category].filter(Boolean).join(" · ") } },
};

function checksFor(key) {
  const a = ANALYZERS[key] || {};
  const list = [...(a.checks || [])];
  if (a.dup !== false) list.push(dupCheck(a.dup || {}));
  return list;
}

/**
 * Analiza todas las filas de un tipo. Muta cada fila con { issues, health }.
 * getRows(key) devuelve (cacheadas) las filas de otro tipo para reglas cruzadas.
 */
export async function analyzeMetadata(def, rows, { getRows, api }) {
  let sobjects = null;
  const unavailable = [];
  const ctx = {
    typeKey: def.key,
    typeLabel: def.label,
    rows: (key) => getRows(key),
    async optionalRows(key) {
      try {
        return await getRows(key);
      } catch {
        unavailable.push(key);
        return [];
      }
    },
    async sobjects() {
      if (!sobjects) {
        const all = await api.describeGlobal().catch(() => []);
        sobjects = { byLabel: new Map(), byName: new Map(), standard: new Set() };
        for (const s of all) {
          if (!sobjects.byLabel.has(lc(s.label))) sobjects.byLabel.set(lc(s.label), s.name);
          sobjects.byName.set(lc(s.name), s.name);
          if (!s.custom) sobjects.standard.add(lc(s.name));
        }
      }
      return sobjects;
    },
    async flows() {
      const flows = def.key === "Flow" ? rows : await getRows("Flow");
      await prepareFlows(flows, ctx);
      return flows;
    },
  };

  if (def.key === "Flow") await prepareFlows(rows, ctx);
  for (const r of rows) r.issues = [];

  const done = [];
  const skipped = [];
  for (const check of checksFor(def.key)) {
    try {
      await check.run(rows, ctx);
      done.push(check.label);
    } catch (e) {
      skipped.push({ label: check.label, reason: e?.message || String(e) });
    }
  }
  const rank = { error: 0, warning: 1 };
  for (const r of rows) {
    r.issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    r.health = r.issues.some((i) => i.severity === "error") ? "error" : r.issues.length ? "warning" : "ok";
  }
  for (const k of new Set(unavailable)) {
    skipped.push({
      label: L(`Cruce con ${k}`, `Cross-check with ${k}`),
      reason: L("tu usuario no tiene acceso o no está disponible en la org", "your user has no access or it isn't available in the org"),
    });
  }
  return { checks: done, skipped };
}

/** Determina el API name del objeto de cada flow (por Id o, si no, por su label). */
async function prepareFlows(flows, ctx) {
  if (flows._prepared) return;
  const s = await ctx.sobjects();
  for (const f of flows) {
    let o = f.objectApi && !looksLikeId(f.objectApi) ? f.objectApi : null;
    if (!o && f.object) o = s.byLabel.get(lc(f.object)) || s.byName.get(lc(f.object)) || null;
    f._obj = o;
  }
  flows._prepared = true;
}
