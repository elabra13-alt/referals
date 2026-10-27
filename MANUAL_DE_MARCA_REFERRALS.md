# Manual de Marca & Guía de Comunicación — Referrals

> **Versión:** 1.1 (Revisión Oficial — Fusión Sólida TikTok + Instagram)  
> **Producto:** Referrals  
> **Área:** Producto, Diseño & Estrategia Comercial  
> **Fecha:** Octubre 2026  

---

## 1. Esencia de Marca y Declaración de Posicionamiento

### Nombre Oficial
**Referrals**

### Tagline Principal
> **"El puente inteligente que une productos con los creadores que saben venderlos."**

### Declaración de Misión
Referrals elimina la intermediación ineficiente, la burocracia y la publicidad a ciegas en el comercio digital. Conectamos a dueños y marcas de productos físicos (cosméticos, autopartes, juguetes, gadgets, hogar, etc.) con influencers de nicho que tienen la confianza genuina de su audiencia, asegurando resultados medibles, pagos puntuales y cero riesgo financiero.

---

## 2. Personalidad y Tono de Voz

Referrals combina la agilidad y frescura de los creadores modernos con la formalidad y solidez que exigen los dueños de negocios y marcas.

### Atributos Clave de la Personalidad:
* **Pragmático y Comercial:** Enfocado en ventas reales, márgenes, entregas a tiempo y rentabilidad comprobada.
* **Transparente y Confiable:** Habla con claridad de números, comisiones, plazos de pago y condiciones sin letras chiquitas.
* **Dinámico y Editorial (Estilo TikTok + Instagram):** Visualmente atractivo, directo al punto, con datos claros y sin rodeos.
* **Universal y Accesible:** Redacción directa, sin tecnicismos innecesarios ni jerga pasajera de internet; perfectamente comprensible para un fabricante industrial de 55 años y para un creador digital de 22 años.

---

## 3. Matriz de Mensajes por Audiencia

| Audiencia | Enfoque Central del Mensaje | Palabras Clave | Lo que NUNCA decimos |
| :--- | :--- | :--- | :--- |
| **Vendedor / Marca** | *"Deja de pagar por menciones vacías. Paga comisiones solo cuando el producto ya está cobrado y en manos de un comprador real."* | Certeza, margen, ventas reales, muestras rastreadas, cero riesgo. | "Gana visibilidad mágica", "Vuélvete viral sin esfuerzo". |
| **Influencer / Creador** | *"Solo productos que tú mismo probarías. Monetización clara, muestras de cortesía y pagos garantizados directamente a tu cuenta bancaria."* | Curaduría, reputación, monetización híbrida, formalidad, transparencia. | "Publica lo que sea por dinero", "Campaña exprés sin contrato". |

---

## 4. Sistema de Diseño Visual (Fusión Sólida TikTok + Instagram)

### Regla de Oro: Cero Degradados (Strictly Flat Design)
* **Quedan estrictamente prohibidos los degradados (gradients), efectos difusos o neón borroso.**
* Todas las superficies, botones, contenedores y badges deben ser **colores sólidos, planos, limpios y de alto contraste**.

### Paleta de Color Oficial

| Token | Código HEX | Nombre | Inspiración / Aplicación |
| :--- | :--- | :--- | :--- |
| **Fondo Principal** | `#FFFFFF` | Blanco Puro | Superficie base de lectura, tarjetas principales y paneles. |
| **Fondo Secundario** | `#F8FAFC` | Pizarra Clara Neutra | Fondo de página, barras laterales y contenedores secundarios. |
| **Bordes & Separadores** | `#E2E8F0` | Borde Slate Sutil | Bordes limpios de 1px sólido en tarjetas e inputs. |
| **Texto Principal** | `#0F141C` | Pizarra Ultra Oscura | Tipografía principal, títulos y encabezados (máximo contraste WCAG AAA). |
| **Texto Secundario** | `#475569` | Pizarra Media | Subtítulos, etiquetas explicativas y metadatos. |
| **Energía / Trending** | `#FE2C55` | TikTok Coral Sólido | Badges de "Alta Demanda", alertas de conversión y llamados de atención vivos. |
| **Editorial / Social** | `#D62976` | Instagram Berry Sólido | Handles de creadores (@usuario), etiquetas de nicho y categorías de estilo. |
| **Data / Match Score** | `#00B4D8` | Cyan Eléctrico Sólido | Porcentajes de afinidad de audiencia (Match %), tasas de engagement y métricas. |
| **Acción / Éxito / Dinero** | `#10B981` | Fresh Mint Sólido | Botones primarios (CTA), dispersión de pagos, comisiones ganadas y muestras aprobadas. |
| **Acción Hover / Active** | `#059669` | Emerald Sólido | Estado presionado o hover de botones primarios. |
| **Alerta / Escrow** | `#F59E0B` | Ámbar Sólido | Indicadores de periodo de garantía, cuenta regresiva y estados pendientes. |

---

## 5. Estándares Tipográficos y de Cifras Financieras

1. **Tipografía de Interfaz:**
   * Familias autorizadas: `Plus Jakarta Sans`, `Inter` o fuentes sans-serif nativas del sistema.
   * Tamaños generosos: Mínimo 16px para texto regular y 18px en inputs móviles para facilitar lectura a personas adultas y de la tercera edad.
2. **Tratamiento Obligatorio de Cifras Financieras:**
   * Todo monto en dinero ($ MXN), porcentaje de comisión (%), código de cupón y temporizador DEBE formatearse con números tabulares para alineación perfecta:
   ```css
   font-variant-numeric: tabular-nums;
   font-feature-settings: "tnum";
   ```
3. **Ergonomía de Interacción:**
   * Todos los botones táctiles y áreas interactivas deben tener una altura mínima de **48px** para garantizar facilidad de toque en dispositivos móviles sin errores accidentales.

---

## 6. Nomenclatura y Estandarización de Códigos de Descuento

Para garantizar la seguridad y evitar filtraciones o patrones predecibles, la sintaxis oficial es:

$$\text{REF-}[\text{SLUG\_CREADOR}]-[\text{ENTROPÍA\_CROCKFORD}]$$

* **Ejemplo real:** `REF-MORA-7K2X`
* `SLUG_CREADOR`: 3 a 5 caracteres alfanuméricos identificando al creador (ej. `MORA`).
* `ENTROPÍA`: 4 caracteres en Base32 Crockford modificado (`23456789ABCDEFGHJKMNPQRSTVWXYZ`), excluyendo expresamente caracteres ambiguos (`0`, `O`, `1`, `I`, `L`).
