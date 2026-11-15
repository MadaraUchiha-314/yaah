# Demo transcript (temporal-embedded)

Workflow link shown by the web chat: http://127.0.0.1:18233/namespaces/default/workflows/yaah-523e9f6b-b9cc-48fa-ac55-7f06fb233d0f

## Web chat, at the end

```text
Agent
3 tool calls
mcp__orders__lookup_order
ok
30 ms
mcp__orders__refund_policy
ok
21 ms
plan_set
ok
3 ms
Your ceramic lamp cost €240. Damaged-on-arrival refunds are available within 30 days of delivery; this amount requires approval.
What happened?
Can you send a photo?
Yes
No
Submit details
1 tool call
plan_update_step
ok
2 ms
I’ve noted the lampshade is cracked in two places. The €240 refund requires approval before I can confirm it.
Can you send a photo?
Yes
No
Please select Yes or No.
Submit
The lampshade is cracked and I can send a photo. Please request the refund.
Agent
2 tool calls
plan_update_step
ok
1 ms
plan_update_step
ok
2 ms

NEEDS YOUR INPUT

Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade arrived cracked in two places? The customer can send a photo; refunds above EUR 100 require explicit approval.

Approved. Refund the full amount.
Agent
2 tool calls
plan_update_step
ok
2 ms
plan_update_step
ok
2 ms
Your full EUR 240 refund for order A-1041 is approved. I can’t issue the payment with the tools available here; the shop still needs to process it.
/model
Thanks. When will the money arrive?
Agent
The EUR 240 refund is approved, but it has not been issued—I don’t have a tool to process the payment. The shop still needs to issue it and confirm the expected arrival date.
```

## Terminal chat: on attaching, after answering, after the last turn

```text
      │ of delivery; this amount requires approval.                                            │
      │   What happened?: Describe the damage to the lamp                                      │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit details ]                                                                   │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ I’ve noted the lampshade is cracked in two places. The €240 refund requires approval   │
      │ before I can confirm it.                                                               │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit ]                                                                           │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   The lampshade is cracked and I can send a photo. Please request the refund.
agent ┃ Needs your input
      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? The customer can send a photo; refunds above EUR 100
      ┃ require explicit approval.
────────────────────────────────────────────────────────────────────────────────
> ▍ Answer the agent
────────────────────────────────────────────────────────────────────────────────
▲ Needs your input · Temporal:
http://127.0.0.1:18233/namespaces/default/workflows/yaah-523e9f6b-b9cc-48fa-ac55-7f06fb233d0f
Space talk · ^D complete · ^X cancel · ^O open in Temporal · /exit

agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ I’ve noted the lampshade is cracked in two places. The €240 refund requires approval   │
      │ before I can confirm it.                                                               │
      │   Can you send a photo?                                                                │
      │   ( ) Yes                                                                              │
      │   ( ) No                                                                               │
      │   [ Submit ]                                                                           │
      │ Tab move · Space select · arrows change                                                │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   The lampshade is cracked and I can send a photo. Please request the refund.
agent ┃ Needs your input
      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? The customer can send a photo; refunds above EUR 100
      ┃ require explicit approval.
you   Approved. Refund the full amount.
      ✓ plan_update_step 2 ms
      ✓ plan_update_step 2 ms
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ Your full EUR 240 refund for order A-1041 is approved. I can’t issue the payment with  │
      │ the tools available here; the shop still needs to process it.                          │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────
> ▍ Reply, or type / for commands
────────────────────────────────────────────────────────────────────────────────
● Waiting for you · Temporal:
http://127.0.0.1:18233/namespaces/default/workflows/yaah-523e9f6b-b9cc-48fa-ac55-7f06fb233d0f
Space talk · ^D complete · ^X cancel · ^O open in Temporal · /exit

agent ┃ Needs your input
      ┃ Do you explicitly approve the EUR 240 full refund for order A-1041 because the lampshade
      ┃  arrived cracked in two places? The customer can send a photo; refunds above EUR 100
      ┃ require explicit approval.
you   Approved. Refund the full amount.
      ✓ plan_update_step 2 ms
      ✓ plan_update_step 2 ms
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ Your full EUR 240 refund for order A-1041 is approved. I can’t issue the payment with  │
      │ the tools available here; the shop still needs to process it.                          │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
you   /model
      Model: openai/gpt-6.1-sol. Available: anthropic/claude-fable-5-2, 
      anthropic/claude-haiku-5-5, anthropic/claude-opus-5-5, anthropic/claude-sonnet-5-5, 
      openai/gpt-6-astra, openai/gpt-6.1-sol, openai/gpt-6.1-terra.
you   Thanks. When will the money arrive?
agent ╭────────────────────────────────────────────────────────────────────────────────────────╮
      │ A2UI                                                                                   │
      │ The EUR 240 refund is approved, but it has not been issued—I don’t have a tool to      │
      │ process the payment. The shop still needs to issue it and confirm the expected arrival │
      │  date.                                                                                 │
      ╰────────────────────────────────────────────────────────────────────────────────────────╯
────────────────────────────────────────────────────────────────────────────────
> ▍ Reply, or type / for commands
────────────────────────────────────────────────────────────────────────────────
● Waiting for you · Temporal:
http://127.0.0.1:18233/namespaces/default/workflows/yaah-523e9f6b-b9cc-48fa-ac55-7f06fb233d0f
^X cancel · ^O open in Temporal · ^C leave
```

## Workflow history

```text
workflow yaah-523e9f6b-b9cc-48fa-ac55-7f06fb233d0f — COMPLETED
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
 126  MARKER_RECORDED
 127  ACTIVITY_TASK_SCHEDULED performStep
 128  ACTIVITY_TASK_STARTED
 129  ACTIVITY_TASK_COMPLETED
 130  WORKFLOW_TASK_SCHEDULED
 131  WORKFLOW_TASK_STARTED
 132  WORKFLOW_TASK_COMPLETED
 133  MARKER_RECORDED
 134  ACTIVITY_TASK_SCHEDULED performStep
 135  ACTIVITY_TASK_STARTED
 136  ACTIVITY_TASK_COMPLETED
 137  WORKFLOW_TASK_SCHEDULED
 138  WORKFLOW_TASK_STARTED
 139  WORKFLOW_TASK_COMPLETED
 140  MARKER_RECORDED
 141  ACTIVITY_TASK_SCHEDULED performStep
 142  ACTIVITY_TASK_STARTED
 143  ACTIVITY_TASK_COMPLETED
 144  WORKFLOW_TASK_SCHEDULED
 145  WORKFLOW_TASK_STARTED
 146  WORKFLOW_TASK_COMPLETED
 147  WORKFLOW_EXECUTION_SIGNALED inboxItem
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
 207  MARKER_RECORDED
 208  ACTIVITY_TASK_SCHEDULED performStep
 209  ACTIVITY_TASK_STARTED
 210  ACTIVITY_TASK_COMPLETED
 211  WORKFLOW_TASK_SCHEDULED
 212  WORKFLOW_TASK_STARTED
 213  WORKFLOW_TASK_COMPLETED
 214  MARKER_RECORDED
 215  ACTIVITY_TASK_SCHEDULED performStep
 216  ACTIVITY_TASK_STARTED
 217  ACTIVITY_TASK_COMPLETED
 218  WORKFLOW_TASK_SCHEDULED
 219  WORKFLOW_TASK_STARTED
 220  WORKFLOW_TASK_COMPLETED
 221  MARKER_RECORDED
 222  ACTIVITY_TASK_SCHEDULED performStep
 223  ACTIVITY_TASK_STARTED
 224  ACTIVITY_TASK_COMPLETED
 225  WORKFLOW_TASK_SCHEDULED
 226  WORKFLOW_TASK_STARTED
 227  WORKFLOW_TASK_COMPLETED
 228  WORKFLOW_EXECUTION_SIGNALED inboxItem
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
 288  MARKER_RECORDED
 289  ACTIVITY_TASK_SCHEDULED performStep
 290  ACTIVITY_TASK_STARTED
 291  ACTIVITY_TASK_COMPLETED
 292  WORKFLOW_TASK_SCHEDULED
 293  WORKFLOW_TASK_STARTED
 294  WORKFLOW_TASK_COMPLETED
 295  MARKER_RECORDED
 296  ACTIVITY_TASK_SCHEDULED performStep
 297  ACTIVITY_TASK_STARTED
 298  ACTIVITY_TASK_COMPLETED
 299  WORKFLOW_TASK_SCHEDULED
 300  WORKFLOW_TASK_STARTED
 301  WORKFLOW_TASK_COMPLETED
 302  MARKER_RECORDED
 303  ACTIVITY_TASK_SCHEDULED performStep
 304  ACTIVITY_TASK_STARTED
 305  ACTIVITY_TASK_COMPLETED
 306  WORKFLOW_TASK_SCHEDULED
 307  WORKFLOW_TASK_STARTED
 308  WORKFLOW_TASK_COMPLETED
 309  WORKFLOW_EXECUTION_SIGNALED inboxItem
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
 327  MARKER_RECORDED
 328  ACTIVITY_TASK_SCHEDULED performStep
 329  ACTIVITY_TASK_STARTED
 330  ACTIVITY_TASK_COMPLETED
 331  WORKFLOW_TASK_SCHEDULED
 332  WORKFLOW_TASK_STARTED
 333  WORKFLOW_TASK_COMPLETED
 334  MARKER_RECORDED
 335  ACTIVITY_TASK_SCHEDULED performStep
 336  ACTIVITY_TASK_STARTED
 337  ACTIVITY_TASK_COMPLETED
 338  WORKFLOW_TASK_SCHEDULED
 339  WORKFLOW_TASK_STARTED
 340  WORKFLOW_TASK_COMPLETED
 341  MARKER_RECORDED
 342  ACTIVITY_TASK_SCHEDULED performStep
 343  ACTIVITY_TASK_STARTED
 344  ACTIVITY_TASK_COMPLETED
 345  WORKFLOW_TASK_SCHEDULED
 346  WORKFLOW_TASK_STARTED
 347  WORKFLOW_TASK_COMPLETED
 348  WORKFLOW_EXECUTION_SIGNALED inboxItem
 349  WORKFLOW_TASK_SCHEDULED
 350  WORKFLOW_TASK_STARTED
 351  WORKFLOW_TASK_COMPLETED
 352  MARKER_RECORDED
 353  ACTIVITY_TASK_SCHEDULED performStep
 354  ACTIVITY_TASK_STARTED
 355  ACTIVITY_TASK_COMPLETED
 356  WORKFLOW_TASK_SCHEDULED
 357  WORKFLOW_TASK_STARTED
 358  WORKFLOW_TASK_COMPLETED
 359  WORKFLOW_EXECUTION_COMPLETED
```
