# Demo transcript (temporal-remote)

Workflow link shown by the web chat: https://cloud.temporal.io/namespaces/yaah.gtebu/workflows/yaah-714af495-5496-4590-bb89-b112cb4a86e1

## Web chat, at the end

```text
Agent
3 tool calls
mcp__orders__lookup_order
ok
24 ms
mcp__orders__refund_policy
ok
22 ms
plan_set
ok
3 ms
A-1041 · Ceramic lamp · €240
Damaged-on-arrival refunds are available within 30 days of delivery; this amount requires approval.
What happened?
Please describe the damage.
Can you send a photo?
Yes
No
Please select an option.
Submit details
I’ve noted that the lampshade arrived cracked in two places. The €240 refund requires approval.
Can you send a photo?
Yes
No
Submit
The lampshade is cracked and I can send a photo. Please request the refund.
Agent
2 tool calls
plan_update_step
ok
2 ms
plan_update_step
ok
1 ms

NEEDS YOUR INPUT

Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade arrived cracked in two places? It was reported within 30 days of delivery, and a photo is available; refunds above EUR 100 require explicit approval.

Approved. Refund the full amount.
Agent
2 tool calls
plan_update_step
ok
2 ms
plan_update_step
ok
2 ms
The full EUR 240 refund for order A-1041 is approved. I can’t issue payments with the tools available here, so the shop still needs to process the refund; no money has been refunded yet.
/model
Thanks. When will the money arrive?
Agent
The EUR 240 refund for order A-1041 is approved, but it has not been issued. I don’t have a tool to process it; the shop must issue the refund and confirm when the money should arrive.
```

## Terminal chat: on attaching, after answering, after the last turn

```text
      │ requires approval.                                                                     │
      │   What happened?: Describe the damage                                                  │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit details ]                                                                   │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ I’ve noted that the lampshade arrived cracked in two places. The €240 refund requires  │
      │ approval.                                                                              │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit ]                                                                           │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   The lampshade is cracked and I can send a photo. Please request the refund.
agent ┃ Needs your input
      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? It was reported within 30 days of delivery, and a photo
      ┃ is available; refunds above EUR 100 require explicit approval.
────────────────────────────────────────────────────────────────────────────────
> ▍ Answer the agent
────────────────────────────────────────────────────────────────────────────────
▲ Needs your input · Temporal: https://cloud.temporal.io/namespaces/yaah.gtebu/workflows/yaah-71
4af495-5496-4590-bb89-b112cb4a86e1
Space talk · ^D complete · ^X cancel · ^O open in Temporal · /exit

      │ A2UI                                                                                   │
      │ I’ve noted that the lampshade arrived cracked in two places. The €240 refund requires  │
      │ approval.                                                                              │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit ]                                                                           │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   The lampshade is cracked and I can send a photo. Please request the refund.
agent ┃ Needs your input
      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? It was reported within 30 days of delivery, and a photo
      ┃ is available; refunds above EUR 100 require explicit approval.
you   Approved. Refund the full amount.
      ✓ plan_update_step 2 ms
      ✓ plan_update_step 2 ms
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ The full EUR 240 refund for order A-1041 is approved. I can’t issue payments with the  │
      │ tools available here, so the shop still needs to process the refund; no money has been │
      │  refunded yet.                                                                         │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────
> ▍ Reply, or type / for commands
────────────────────────────────────────────────────────────────────────────────
● Waiting for you · Temporal: https://cloud.temporal.io/namespaces/yaah.gtebu/workflows/yaah-714
af495-5496-4590-bb89-b112cb4a86e1
^X cancel · ^O open in Temporal · ^C leave

      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? It was reported within 30 days of delivery, and a photo
      ┃ is available; refunds above EUR 100 require explicit approval.
you   Approved. Refund the full amount.
      ✓ plan_update_step 2 ms
      ✓ plan_update_step 2 ms
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ The full EUR 240 refund for order A-1041 is approved. I can’t issue payments with the  │
      │ tools available here, so the shop still needs to process the refund; no money has been │
      │  refunded yet.                                                                         │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   /model
      Model: openai/gpt-6.1-sol. Available: anthropic/claude-fable-5-2, 
      anthropic/claude-haiku-5-5, anthropic/claude-opus-5-5, anthropic/claude-sonnet-5-5, 
      openai/gpt-6-astra, openai/gpt-6.1-sol, openai/gpt-6.1-terra.
you   Thanks. When will the money arrive?
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ The EUR 240 refund for order A-1041 is approved, but it has not been issued. I don’t   │
      │ have a tool to process it; the shop must issue the refund and confirm when the money   │
      │ should arrive.                                                                         │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────
> ▍ Reply, or type / for commands
────────────────────────────────────────────────────────────────────────────────
● Waiting for you · Temporal: https://cloud.temporal.io/namespaces/yaah.gtebu/workflows/yaah-714
af495-5496-4590-bb89-b112cb4a86e1
Space talk · ^D complete · ^X cancel · ^O open in Temporal · /exit
```

## Workflow history

```text
workflow yaah-714af495-5496-4590-bb89-b112cb4a86e1 — COMPLETED
   1  WORKFLOW_EXECUTION_STARTED
   2  WORKFLOW_EXECUTION_SIGNALED inboxItem
   3  WORKFLOW_TASK_SCHEDULED
   4  WORKFLOW_TASK_STARTED
   5  WORKFLOW_TASK_COMPLETED
   6  MARKER_RECORDED
   7  ACTIVITY_TASK_SCHEDULED performStep
   8  ACTIVITY_TASK_STARTED
   9  ACTIVITY_TASK_COMPLETED
  10  WORKFLOW_TASK_SCHEDULED
  11  WORKFLOW_TASK_STARTED
  12  WORKFLOW_TASK_COMPLETED
  13  MARKER_RECORDED
  14  ACTIVITY_TASK_SCHEDULED performStep
  15  ACTIVITY_TASK_STARTED
  16  ACTIVITY_TASK_COMPLETED
  17  WORKFLOW_TASK_SCHEDULED
  18  WORKFLOW_TASK_STARTED
  19  WORKFLOW_TASK_COMPLETED
  20  MARKER_RECORDED
  21  ACTIVITY_TASK_SCHEDULED performStep
  22  ACTIVITY_TASK_STARTED
  23  ACTIVITY_TASK_COMPLETED
  24  WORKFLOW_TASK_SCHEDULED
  25  WORKFLOW_TASK_STARTED
  26  WORKFLOW_TASK_COMPLETED
  27  MARKER_RECORDED
  28  ACTIVITY_TASK_SCHEDULED performStep
  29  ACTIVITY_TASK_STARTED
  30  ACTIVITY_TASK_COMPLETED
  31  WORKFLOW_TASK_SCHEDULED
  32  WORKFLOW_TASK_STARTED
  33  WORKFLOW_TASK_COMPLETED
  34  MARKER_RECORDED
  35  ACTIVITY_TASK_SCHEDULED performStep
  36  MARKER_RECORDED
  37  ACTIVITY_TASK_SCHEDULED performStep
  38  ACTIVITY_TASK_STARTED
  39  ACTIVITY_TASK_COMPLETED
  40  WORKFLOW_TASK_SCHEDULED
  41  ACTIVITY_TASK_STARTED
  42  ACTIVITY_TASK_COMPLETED
  43  WORKFLOW_TASK_STARTED
  44  WORKFLOW_TASK_COMPLETED
  45  MARKER_RECORDED
  46  ACTIVITY_TASK_SCHEDULED performStep
  47  ACTIVITY_TASK_STARTED
  48  ACTIVITY_TASK_COMPLETED
  49  WORKFLOW_TASK_SCHEDULED
  50  WORKFLOW_TASK_STARTED
  51  WORKFLOW_TASK_COMPLETED
  52  MARKER_RECORDED
  53  ACTIVITY_TASK_SCHEDULED performStep
  54  ACTIVITY_TASK_STARTED
  55  ACTIVITY_TASK_COMPLETED
  56  WORKFLOW_TASK_SCHEDULED
  57  WORKFLOW_TASK_STARTED
  58  WORKFLOW_TASK_COMPLETED
  59  MARKER_RECORDED
  60  ACTIVITY_TASK_SCHEDULED performStep
  61  ACTIVITY_TASK_STARTED
  62  ACTIVITY_TASK_COMPLETED
  63  WORKFLOW_TASK_SCHEDULED
  64  WORKFLOW_TASK_STARTED
  65  WORKFLOW_TASK_COMPLETED
  66  MARKER_RECORDED
  67  ACTIVITY_TASK_SCHEDULED performStep
  68  ACTIVITY_TASK_STARTED
  69  ACTIVITY_TASK_COMPLETED
  70  WORKFLOW_TASK_SCHEDULED
  71  WORKFLOW_TASK_STARTED
  72  WORKFLOW_TASK_COMPLETED
  73  MARKER_RECORDED
  74  ACTIVITY_TASK_SCHEDULED performStep
  75  ACTIVITY_TASK_STARTED
  76  ACTIVITY_TASK_COMPLETED
  77  WORKFLOW_TASK_SCHEDULED
  78  WORKFLOW_TASK_STARTED
  79  WORKFLOW_TASK_COMPLETED
  80  MARKER_RECORDED
  81  ACTIVITY_TASK_SCHEDULED performStep
  82  ACTIVITY_TASK_STARTED
  83  ACTIVITY_TASK_COMPLETED
  84  WORKFLOW_TASK_SCHEDULED
  85  WORKFLOW_TASK_STARTED
  86  WORKFLOW_TASK_COMPLETED
  87  WORKFLOW_EXECUTION_SIGNALED inboxItem
  88  WORKFLOW_TASK_SCHEDULED
  89  WORKFLOW_TASK_STARTED
  90  WORKFLOW_TASK_COMPLETED
  91  MARKER_RECORDED
  92  ACTIVITY_TASK_SCHEDULED performStep
  93  ACTIVITY_TASK_STARTED
  94  ACTIVITY_TASK_COMPLETED
  95  WORKFLOW_TASK_SCHEDULED
  96  WORKFLOW_TASK_STARTED
  97  WORKFLOW_TASK_COMPLETED
  98  MARKER_RECORDED
  99  ACTIVITY_TASK_SCHEDULED performStep
 100  ACTIVITY_TASK_STARTED
 101  ACTIVITY_TASK_COMPLETED
 102  WORKFLOW_TASK_SCHEDULED
 103  WORKFLOW_TASK_STARTED
 104  WORKFLOW_TASK_COMPLETED
 105  MARKER_RECORDED
 106  ACTIVITY_TASK_SCHEDULED performStep
 107  ACTIVITY_TASK_STARTED
 108  ACTIVITY_TASK_COMPLETED
 109  WORKFLOW_TASK_SCHEDULED
 110  WORKFLOW_TASK_STARTED
 111  WORKFLOW_TASK_COMPLETED
 112  MARKER_RECORDED
 113  ACTIVITY_TASK_SCHEDULED performStep
 114  ACTIVITY_TASK_STARTED
 115  ACTIVITY_TASK_COMPLETED
 116  WORKFLOW_TASK_SCHEDULED
 117  WORKFLOW_TASK_STARTED
 118  WORKFLOW_TASK_COMPLETED
 119  MARKER_RECORDED
 120  ACTIVITY_TASK_SCHEDULED performStep
 121  ACTIVITY_TASK_STARTED
 122  ACTIVITY_TASK_COMPLETED
 123  WORKFLOW_TASK_SCHEDULED
 124  WORKFLOW_TASK_STARTED
 125  WORKFLOW_TASK_COMPLETED
 126  WORKFLOW_EXECUTION_SIGNALED inboxItem
 127  WORKFLOW_TASK_SCHEDULED
 128  WORKFLOW_TASK_STARTED
 129  WORKFLOW_TASK_COMPLETED
 130  MARKER_RECORDED
 131  ACTIVITY_TASK_SCHEDULED performStep
 132  ACTIVITY_TASK_STARTED
 133  ACTIVITY_TASK_COMPLETED
 134  WORKFLOW_TASK_SCHEDULED
 135  WORKFLOW_TASK_STARTED
 136  WORKFLOW_TASK_COMPLETED
 137  MARKER_RECORDED
 138  ACTIVITY_TASK_SCHEDULED performStep
 139  ACTIVITY_TASK_STARTED
 140  ACTIVITY_TASK_COMPLETED
 141  WORKFLOW_TASK_SCHEDULED
 142  WORKFLOW_TASK_STARTED
 143  WORKFLOW_TASK_COMPLETED
 144  MARKER_RECORDED
 145  ACTIVITY_TASK_SCHEDULED performStep
 146  ACTIVITY_TASK_STARTED
 147  ACTIVITY_TASK_COMPLETED
 148  WORKFLOW_TASK_SCHEDULED
 149  WORKFLOW_TASK_STARTED
 150  WORKFLOW_TASK_COMPLETED
 151  MARKER_RECORDED
 152  ACTIVITY_TASK_SCHEDULED performStep
 153  ACTIVITY_TASK_STARTED
 154  ACTIVITY_TASK_COMPLETED
 155  WORKFLOW_TASK_SCHEDULED
 156  WORKFLOW_TASK_STARTED
 157  WORKFLOW_TASK_COMPLETED
 158  MARKER_RECORDED
 159  ACTIVITY_TASK_SCHEDULED performStep
 160  ACTIVITY_TASK_STARTED
 161  ACTIVITY_TASK_COMPLETED
 162  WORKFLOW_TASK_SCHEDULED
 163  WORKFLOW_TASK_STARTED
 164  WORKFLOW_TASK_COMPLETED
 165  MARKER_RECORDED
 166  ACTIVITY_TASK_SCHEDULED performStep
 167  ACTIVITY_TASK_STARTED
 168  ACTIVITY_TASK_COMPLETED
 169  WORKFLOW_TASK_SCHEDULED
 170  WORKFLOW_TASK_STARTED
 171  WORKFLOW_TASK_COMPLETED
 172  MARKER_RECORDED
 173  ACTIVITY_TASK_SCHEDULED performStep
 174  ACTIVITY_TASK_STARTED
 175  ACTIVITY_TASK_COMPLETED
 176  WORKFLOW_TASK_SCHEDULED
 177  WORKFLOW_TASK_STARTED
 178  WORKFLOW_TASK_COMPLETED
 179  MARKER_RECORDED
 180  ACTIVITY_TASK_SCHEDULED performStep
 181  ACTIVITY_TASK_STARTED
 182  ACTIVITY_TASK_COMPLETED
 183  WORKFLOW_TASK_SCHEDULED
 184  WORKFLOW_TASK_STARTED
 185  WORKFLOW_TASK_COMPLETED
 186  MARKER_RECORDED
 187  ACTIVITY_TASK_SCHEDULED performStep
 188  ACTIVITY_TASK_STARTED
 189  ACTIVITY_TASK_COMPLETED
 190  WORKFLOW_TASK_SCHEDULED
 191  WORKFLOW_TASK_STARTED
 192  WORKFLOW_TASK_COMPLETED
 193  MARKER_RECORDED
 194  ACTIVITY_TASK_SCHEDULED performStep
 195  ACTIVITY_TASK_STARTED
 196  ACTIVITY_TASK_COMPLETED
 197  WORKFLOW_TASK_SCHEDULED
 198  WORKFLOW_TASK_STARTED
 199  WORKFLOW_TASK_COMPLETED
 200  MARKER_RECORDED
 201  ACTIVITY_TASK_SCHEDULED performStep
 202  ACTIVITY_TASK_STARTED
 203  ACTIVITY_TASK_COMPLETED
 204  WORKFLOW_TASK_SCHEDULED
 205  WORKFLOW_TASK_STARTED
 206  WORKFLOW_TASK_COMPLETED
 207  WORKFLOW_EXECUTION_SIGNALED inboxItem
 208  WORKFLOW_TASK_SCHEDULED
 209  WORKFLOW_TASK_STARTED
 210  WORKFLOW_TASK_COMPLETED
 211  MARKER_RECORDED
 212  ACTIVITY_TASK_SCHEDULED performStep
 213  ACTIVITY_TASK_STARTED
 214  ACTIVITY_TASK_COMPLETED
 215  WORKFLOW_TASK_SCHEDULED
 216  WORKFLOW_TASK_STARTED
 217  WORKFLOW_TASK_COMPLETED
 218  MARKER_RECORDED
 219  ACTIVITY_TASK_SCHEDULED performStep
 220  ACTIVITY_TASK_STARTED
 221  ACTIVITY_TASK_COMPLETED
 222  WORKFLOW_TASK_SCHEDULED
 223  WORKFLOW_TASK_STARTED
 224  WORKFLOW_TASK_COMPLETED
 225  MARKER_RECORDED
 226  ACTIVITY_TASK_SCHEDULED performStep
 227  ACTIVITY_TASK_STARTED
 228  ACTIVITY_TASK_COMPLETED
 229  WORKFLOW_TASK_SCHEDULED
 230  WORKFLOW_TASK_STARTED
 231  WORKFLOW_TASK_COMPLETED
 232  MARKER_RECORDED
 233  ACTIVITY_TASK_SCHEDULED performStep
 234  ACTIVITY_TASK_STARTED
 235  ACTIVITY_TASK_COMPLETED
 236  WORKFLOW_TASK_SCHEDULED
 237  WORKFLOW_TASK_STARTED
 238  WORKFLOW_TASK_COMPLETED
 239  MARKER_RECORDED
 240  ACTIVITY_TASK_SCHEDULED performStep
 241  ACTIVITY_TASK_STARTED
 242  ACTIVITY_TASK_COMPLETED
 243  WORKFLOW_TASK_SCHEDULED
 244  WORKFLOW_TASK_STARTED
 245  WORKFLOW_TASK_COMPLETED
 246  MARKER_RECORDED
 247  ACTIVITY_TASK_SCHEDULED performStep
 248  ACTIVITY_TASK_STARTED
 249  ACTIVITY_TASK_COMPLETED
 250  WORKFLOW_TASK_SCHEDULED
 251  WORKFLOW_TASK_STARTED
 252  WORKFLOW_TASK_COMPLETED
 253  MARKER_RECORDED
 254  ACTIVITY_TASK_SCHEDULED performStep
 255  ACTIVITY_TASK_STARTED
 256  ACTIVITY_TASK_COMPLETED
 257  WORKFLOW_TASK_SCHEDULED
 258  WORKFLOW_TASK_STARTED
 259  WORKFLOW_TASK_COMPLETED
 260  MARKER_RECORDED
 261  ACTIVITY_TASK_SCHEDULED performStep
 262  ACTIVITY_TASK_STARTED
 263  ACTIVITY_TASK_COMPLETED
 264  WORKFLOW_TASK_SCHEDULED
 265  WORKFLOW_TASK_STARTED
 266  WORKFLOW_TASK_COMPLETED
 267  MARKER_RECORDED
 268  ACTIVITY_TASK_SCHEDULED performStep
 269  ACTIVITY_TASK_STARTED
 270  ACTIVITY_TASK_COMPLETED
 271  WORKFLOW_TASK_SCHEDULED
 272  WORKFLOW_TASK_STARTED
 273  WORKFLOW_TASK_COMPLETED
 274  MARKER_RECORDED
 275  ACTIVITY_TASK_SCHEDULED performStep
 276  ACTIVITY_TASK_STARTED
 277  ACTIVITY_TASK_COMPLETED
 278  WORKFLOW_TASK_SCHEDULED
 279  WORKFLOW_TASK_STARTED
 280  WORKFLOW_TASK_COMPLETED
 281  MARKER_RECORDED
 282  ACTIVITY_TASK_SCHEDULED performStep
 283  ACTIVITY_TASK_STARTED
 284  ACTIVITY_TASK_COMPLETED
 285  WORKFLOW_TASK_SCHEDULED
 286  WORKFLOW_TASK_STARTED
 287  WORKFLOW_TASK_COMPLETED
 288  WORKFLOW_EXECUTION_SIGNALED inboxItem
 289  WORKFLOW_TASK_SCHEDULED
 290  WORKFLOW_TASK_STARTED
 291  WORKFLOW_TASK_COMPLETED
 292  MARKER_RECORDED
 293  ACTIVITY_TASK_SCHEDULED performStep
 294  ACTIVITY_TASK_STARTED
 295  ACTIVITY_TASK_COMPLETED
 296  WORKFLOW_TASK_SCHEDULED
 297  WORKFLOW_TASK_STARTED
 298  WORKFLOW_TASK_COMPLETED
 299  MARKER_RECORDED
 300  ACTIVITY_TASK_SCHEDULED performStep
 301  ACTIVITY_TASK_STARTED
 302  ACTIVITY_TASK_COMPLETED
 303  WORKFLOW_TASK_SCHEDULED
 304  WORKFLOW_TASK_STARTED
 305  WORKFLOW_TASK_COMPLETED
 306  MARKER_RECORDED
 307  ACTIVITY_TASK_SCHEDULED performStep
 308  ACTIVITY_TASK_STARTED
 309  ACTIVITY_TASK_COMPLETED
 310  WORKFLOW_TASK_SCHEDULED
 311  WORKFLOW_TASK_STARTED
 312  WORKFLOW_TASK_COMPLETED
 313  MARKER_RECORDED
 314  ACTIVITY_TASK_SCHEDULED performStep
 315  ACTIVITY_TASK_STARTED
 316  ACTIVITY_TASK_COMPLETED
 317  WORKFLOW_TASK_SCHEDULED
 318  WORKFLOW_TASK_STARTED
 319  WORKFLOW_TASK_COMPLETED
 320  MARKER_RECORDED
 321  ACTIVITY_TASK_SCHEDULED performStep
 322  ACTIVITY_TASK_STARTED
 323  ACTIVITY_TASK_COMPLETED
 324  WORKFLOW_TASK_SCHEDULED
 325  WORKFLOW_TASK_STARTED
 326  WORKFLOW_TASK_COMPLETED
 327  WORKFLOW_EXECUTION_SIGNALED inboxItem
 328  WORKFLOW_TASK_SCHEDULED
 329  WORKFLOW_TASK_STARTED
 330  WORKFLOW_TASK_COMPLETED
 331  MARKER_RECORDED
 332  ACTIVITY_TASK_SCHEDULED performStep
 333  ACTIVITY_TASK_STARTED
 334  ACTIVITY_TASK_COMPLETED
 335  WORKFLOW_TASK_SCHEDULED
 336  WORKFLOW_TASK_STARTED
 337  WORKFLOW_TASK_COMPLETED
 338  WORKFLOW_EXECUTION_COMPLETED
```
